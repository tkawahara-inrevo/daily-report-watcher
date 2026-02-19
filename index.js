import cron from "node-cron";
import dayjs from "dayjs";
import utc from "dayjs/plugin/utc.js";
import timezone from "dayjs/plugin/timezone.js";
import { WebClient } from "@slack/web-api";

dayjs.extend(utc);
dayjs.extend(timezone);

/**
 * ENV
 */
const TZ = process.env.TIMEZONE || "Asia/Tokyo";
const BOT_TOKEN = process.env.SLACK_BOT_TOKEN;

const USERGROUP_ID = process.env.USERGROUP_ID; // 提出対象者（社員など）
const ADMIN_USERGROUP_ID = process.env.ADMIN_USERGROUP_ID || ""; // 日報管理者ユーザーグループID: S...

// 退勤
const REPORT_CHANNEL_OUT = process.env.REPORT_CHANNEL_OUT;
const CUTOFF_TIME_OUT = process.env.CUTOFF_TIME_OUT || "23:59"; // ★A案：当日中判定なら 23:59 推奨

// 出勤（任意）
const REPORT_CHANNEL_IN = process.env.REPORT_CHANNEL_IN || "";
const CUTOFF_TIME_IN = process.env.CUTOFF_TIME_IN || "12:00";

// 起動テスト（trueなら起動直後に1回チェック）
// ★ただし TEST_NOTIFY_CHANNEL が無いと発火しない（事故防止）
const RUN_ON_BOOT = (process.env.RUN_ON_BOOT || "").toLowerCase() === "true";
const TEST_NOTIFY_CHANNEL = process.env.TEST_NOTIFY_CHANNEL || "";

if (!BOT_TOKEN) throw new Error("Missing env: SLACK_BOT_TOKEN");
if (!USERGROUP_ID) throw new Error("Missing env: USERGROUP_ID");
if (!REPORT_CHANNEL_OUT) throw new Error("Missing env: REPORT_CHANNEL_OUT");

if (!ADMIN_USERGROUP_ID) {
  console.warn("WARN: ADMIN_USERGROUP_ID is not set. Admin mention will be omitted.");
}

const client = new WebClient(BOT_TOKEN);

/**
 * Slack API helpers
 */
async function getUserIdsFromUsergroup(usergroupId) {
  const res = await client.usergroups.users.list({ usergroup: usergroupId });
  return res.users || [];
}

async function fetchAllMessagesInRange(channelId, oldestUnix, latestUnix) {
  const messages = [];
  let cursor = undefined;

  while (true) {
    const res = await client.conversations.history({
      channel: channelId,
      oldest: oldestUnix,
      latest: latestUnix,
      limit: 200,
      cursor,
    });

    if (res.messages?.length) messages.push(...res.messages);

    cursor = res.response_metadata?.next_cursor;
    if (!cursor) break;
  }

  return messages;
}

/**
 * Extract submitter:
 * ワークフロー投稿に「報告者（メンション）」が含まれている前提で、
 * 最初の <@U...> を提出者として採用。
 */
function extractSubmitterUserId(message) {
  const text = message?.text || "";
  const mentionRegex = /<@([A-Z0-9]+)>/g;
  const matches = [...text.matchAll(mentionRegex)];
  if (matches.length === 0) return null;
  return matches[0][1];
}

function uniq(array) {
  return [...new Set(array)];
}

function adminMentionText() {
  return ADMIN_USERGROUP_ID ? `<!subteam^${ADMIN_USERGROUP_ID}>` : "";
}

/**
 * 判定レンジ：
 * start = 今日 00:00:00
 * end   = 今日 cutoff(HH:mm) の「直前1秒」まで（例：12:00 -> 11:59:59）
 * ただし cutoff="23:59" は当日中扱いにしたいので 23:59:59 にする
 */
function getTodayRangeUnix(cutoffTimeHHmm) {
  const now = dayjs().tz(TZ);
  const start = now.startOf("day");

  let cutoff = dayjs.tz(`${now.format("YYYY-MM-DD")} ${cutoffTimeHHmm}`, TZ);

  if (cutoffTimeHHmm === "23:59") {
    cutoff = cutoff.add(59, "second"); // 23:59:59
  } else {
    cutoff = cutoff.subtract(1, "second"); // 12:00 -> 11:59:59
  }

  if (cutoff.isBefore(start)) {
    cutoff = start.add(23, "hour").add(59, "minute").add(59, "second");
  }

  return {
    now,
    startUnix: start.unix(),
    endUnix: cutoff.unix(),
  };
}

/**
 * メンションしないため、ユーザーID -> 表示名へ変換
 * ★ users:read が必要
 *
 * 1人ずつ users.info を叩くと重いので、users.list で一括取得して map を作る。
 */
async function buildUserIdToNameMap() {
  const map = new Map();
  let cursor = undefined;

  while (true) {
    const res = await client.users.list({
      limit: 200,
      cursor,
    });

    for (const u of res.members || []) {
      if (!u?.id) continue;
      const name =
        u.profile?.display_name ||
        u.profile?.real_name ||
        u.real_name ||
        u.name ||
        u.id;
      map.set(u.id, name);
    }

    cursor = res.response_metadata?.next_cursor;
    if (!cursor) break;
  }

  return map;
}

function mapUserIdsToNames(userIds, idToNameMap) {
  return userIds.map((uid) => idToNameMap.get(uid) || uid);
}

/**
 * 通知（チャンネルに投稿）
 * - 親：管理者メンション + 対象/未提出
 * - スレッド：未提出者の「名前だけ」一覧（メンション無し）
 */
async function postAdminSummaryThreaded({
  channelId,
  label,
  now,
  targetsCount,
  missingUserIds,
  idToNameMap,
}) {
  const adminMention = adminMentionText();
  const missingCount = missingUserIds.length;

  const parentText = `${adminMention}
本日の${label}日報未提出者をお知らせします。

日付：${now.format("YYYY-MM-DD")}
対象：${targetsCount}
未提出：${missingCount}

※欠勤/休暇者が含まれる可能性があります。勤務者のみに絞って手動フォローしてください。`;

  const parentRes = await client.chat.postMessage({
    channel: channelId,
    text: parentText,
  });

  if (missingCount === 0) {
    await client.chat.postMessage({
      channel: channelId,
      thread_ts: parentRes.ts,
      text: "未提出者はいません 🎉",
    });
    return;
  }

  // スレッドに「名前だけ」を分割投稿
  const chunkSize = 40;
  for (let i = 0; i < missingUserIds.length; i += chunkSize) {
    const chunk = missingUserIds.slice(i, i + chunkSize);
    const names = mapUserIdsToNames(chunk, idToNameMap);

    const body =
      i === 0
        ? `未提出者は以下の通りです。\n\n${names.join("\n")}`
        : names.join("\n");

    await client.chat.postMessage({
      channel: channelId,
      thread_ts: parentRes.ts,
      text: body,
    });
  }
}

/**
 * Core check
 *
 * notifyChannelId:
 *  - 未指定なら reportChannelId（＝出勤は出勤チャンネル、退勤は退勤チャンネル）
 *  - 起動テスト時だけ TEST_NOTIFY_CHANNEL に差し替える用途
 */
async function runCheck({ label, reportChannelId, cutoffTime, notifyChannelId }) {
  const { now, startUnix, endUnix } = getTodayRangeUnix(cutoffTime);

  console.log(`[${label}] start check`, {
    reportChannelId,
    cutoffTime,
    startUnix,
    endUnix,
    now: now.format(),
    notifyChannelId: notifyChannelId || reportChannelId,
  });

  // 1) 対象者
  const targetUserIds = await getUserIdsFromUsergroup(USERGROUP_ID);
  const targetsSet = new Set(targetUserIds);

  // 2) チャンネル履歴（当日レンジ）
  const messages = await fetchAllMessagesInRange(reportChannelId, startUnix, endUnix);

  // 3) 提出者抽出
  const submitters = [];
  for (const msg of messages) {
    const uid = extractSubmitterUserId(msg);
    if (uid) submitters.push(uid);
  }

  // 対象者に含まれる提出のみ採用（関係者以外のメンション混入対策）
  const submittedUserIds = uniq(submitters).filter((u) => targetsSet.has(u));
  const submittedSet = new Set(submittedUserIds);

  // 4) 未提出 = 対象 - 提出
  const missingUserIds = targetUserIds.filter((u) => !submittedSet.has(u));

  console.log(`[${label}] result`, {
    targets: targetUserIds.length,
    messages: messages.length,
    submitted: submittedUserIds.length,
    missing: missingUserIds.length,
  });

  // 5) 名前変換マップ（users.list 一括）
  const idToNameMap = await buildUserIdToNameMap();

  // 6) 通知
  await postAdminSummaryThreaded({
    channelId: notifyChannelId || reportChannelId,
    label,
    now,
    targetsCount: targetUserIds.length,
    missingUserIds,
    idToNameMap,
  });
}

/**
 * Scheduling
 */
function scheduleJobs() {
  // 退勤: 毎日 CUTOFF_TIME_OUT (JST)
  cron.schedule(
    `${parseInt(CUTOFF_TIME_OUT.split(":")[1], 10)} ${parseInt(CUTOFF_TIME_OUT.split(":")[0], 10)} * * *`,
    async () => {
      try {
        await runCheck({
          label: "退勤",
          reportChannelId: REPORT_CHANNEL_OUT,
          cutoffTime: CUTOFF_TIME_OUT,
        });
      } catch (e) {
        console.error("[退勤] job error", e);
      }
    },
    { timezone: TZ }
  );

  // 出勤（設定されている場合のみ）
  if (REPORT_CHANNEL_IN) {
    cron.schedule(
      `${parseInt(CUTOFF_TIME_IN.split(":")[1], 10)} ${parseInt(CUTOFF_TIME_IN.split(":")[0], 10)} * * *`,
      async () => {
        try {
          await runCheck({
            label: "出勤",
            reportChannelId: REPORT_CHANNEL_IN,
            cutoffTime: CUTOFF_TIME_IN,
          });
        } catch (e) {
          console.error("[出勤] job error", e);
        }
      },
      { timezone: TZ }
    );
  }

  console.log("cron scheduled", {
    TZ,
    CUTOFF_TIME_OUT,
    CUTOFF_TIME_IN,
    hasIn: !!REPORT_CHANNEL_IN,
  });
}

/**
 * Main
 */
(async () => {
  console.log("daily-report-watcher boot", { TZ, RUN_ON_BOOT, hasTestChannel: !!TEST_NOTIFY_CHANNEL });

  scheduleJobs();

  // 起動テストはテスト用チャンネルが設定されている場合のみ実行（事故防止）
  if (RUN_ON_BOOT) {
    if (!TEST_NOTIFY_CHANNEL) {
      console.warn("RUN_ON_BOOT=true but TEST_NOTIFY_CHANNEL is not set. Skip boot test to avoid notifying production channels.");
      return;
    }

    try {
      await runCheck({
        label: "退勤(起動テスト)",
        reportChannelId: REPORT_CHANNEL_OUT,
        cutoffTime: CUTOFF_TIME_OUT,
        notifyChannelId: TEST_NOTIFY_CHANNEL,
      });
    } catch (e) {
      console.error("[起動テスト] error", e);
    }
  }
})();
