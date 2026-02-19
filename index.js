import { WebClient } from "@slack/web-api";
import cron from "node-cron";
import dayjs from "dayjs";
import utc from "dayjs/plugin/utc.js";
import timezone from "dayjs/plugin/timezone.js";

dayjs.extend(utc);
dayjs.extend(timezone);

/**
 * ENV
 */
const TZ = process.env.TIMEZONE || "Asia/Tokyo";
const BOT_TOKEN = process.env.SLACK_BOT_TOKEN;

const USERGROUP_ID = process.env.USERGROUP_ID; // 提出対象者（社員など）
const ADMIN_USERGROUP_ID = process.env.ADMIN_USERGROUP_ID || ""; // 日報管理者（ユーザーグループID: S...）

// 退勤
const REPORT_CHANNEL_OUT = process.env.REPORT_CHANNEL_OUT;
const CUTOFF_TIME_OUT = process.env.CUTOFF_TIME_OUT || "00:30";
const WORKFLOW_URL_OUT = process.env.WORKFLOW_URL_OUT || "";

// 出勤（任意）
const REPORT_CHANNEL_IN = process.env.REPORT_CHANNEL_IN || "";
const CUTOFF_TIME_IN = process.env.CUTOFF_TIME_IN || "10:00";
const WORKFLOW_URL_IN = process.env.WORKFLOW_URL_IN || "";

// 初回テスト用（trueなら起動直後に1回チェック）
const RUN_ON_BOOT = (process.env.RUN_ON_BOOT || "").toLowerCase() === "true";

if (!BOT_TOKEN) throw new Error("Missing env: SLACK_BOT_TOKEN");
if (!USERGROUP_ID) throw new Error("Missing env: USERGROUP_ID");
if (!REPORT_CHANNEL_OUT) throw new Error("Missing env: REPORT_CHANNEL_OUT");

// ADMIN_USERGROUP_ID は「@日報管理者メンション」に使うだけなので必須ではないが、設定推奨
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
      cursor
    });

    if (res.messages?.length) messages.push(...res.messages);

    cursor = res.response_metadata?.next_cursor;
    if (!cursor) break;
  }

  return messages;
}

/**
 * Extract the submitter from a workflow-generated message.
 * We rely on the fact that the workflow includes a user mention for "報告者".
 *
 * Strategy (simple & stable start):
 * - Take the FIRST user mention in message.text: <@UXXXX>
 */
function extractSubmitterUserId(message) {
  const text = message?.text || "";
  const mentionRegex = /<@([A-Z0-9]+)>/g;
  const matches = [...text.matchAll(mentionRegex)];
  if (matches.length === 0) return null;
  return matches[0][1]; // first mention = submitter
}

function uniq(array) {
  return [...new Set(array)];
}

/**
 * Time range helpers
 * Check range = today 00:00:00 ~ cutoffTime (Asia/Tokyo)
 */
function getTodayRangeUnix(cutoffTimeHHmm) {
  const now = dayjs().tz(TZ);
  const start = now.startOf("day");
  const cutoff = dayjs.tz(`${now.format("YYYY-MM-DD")} ${cutoffTimeHHmm}`, TZ);

  // If cutoff is earlier than start (shouldn't happen with HH:mm), guard anyway
  const end = cutoff.isBefore(start) ? start.add(1, "day") : cutoff;

  return {
    now,
    startUnix: start.unix(),
    endUnix: end.unix()
  };
}

function adminMentionText() {
  return ADMIN_USERGROUP_ID ? `<!subteam^${ADMIN_USERGROUP_ID}>` : "";
}

function formatMentionsAsLines(userIds) {
  return userIds.map((u) => `<@${u}>`).join("\n");
}

async function postAdminSummaryThreaded({
  channelId,
  label,
  now,
  targetsCount,
  submittedCount,
  missingUserIds,
  workflowUrl
}) {
  const adminMention = adminMentionText();
  const missingCount = missingUserIds.length;

  // 親メッセージ：管理者メンション＋概要（投稿先は日報チャンネル）
  const parentText =
`${adminMention}
本日の${label}日報未提出者をお知らせします。

日付：${now.format("YYYY-MM-DD")}
対象：${targetsCount}
検出：${submittedCount}
未検出（未提出候補）：${missingCount}

提出はこちら 👉 ${workflowUrl || "（URL未設定）"}
※欠勤/休暇者が含まれる可能性があります。勤務者のみに絞って手動フォローしてください。`;

  const parentRes = await client.chat.postMessage({
    channel: channelId,
    text: parentText
  });

  // スレッド：未提出者一覧
  if (missingCount === 0) {
    await client.chat.postMessage({
      channel: channelId,
      thread_ts: parentRes.ts,
      text: "未検出者はありません 🎉"
    });
    return;
  }

  // 多い場合に備えて分割（スレッドで複数投稿）
  const chunkSize = 40;
  for (let i = 0; i < missingUserIds.length; i += chunkSize) {
    const chunk = missingUserIds.slice(i, i + chunkSize);
    const body =
      i === 0
        ? `未検出（未提出候補）は以下の通りです。\n\n${formatMentionsAsLines(chunk)}`
        : formatMentionsAsLines(chunk);

    await client.chat.postMessage({
      channel: channelId,
      thread_ts: parentRes.ts,
      text: body
    });
  }
}

/**
 * Core check
 */
async function runCheck({ label, reportChannelId, cutoffTime, workflowUrl }) {
  const { now, startUnix, endUnix } = getTodayRangeUnix(cutoffTime);

  console.log(`[${label}] start check`, {
    reportChannelId,
    cutoffTime,
    startUnix,
    endUnix,
    now: now.format()
  });

  // 1) targets
  const targetUserIds = await getUserIdsFromUsergroup(USERGROUP_ID);
  const targetsSet = new Set(targetUserIds);

  // 2) messages in range
  const messages = await fetchAllMessagesInRange(reportChannelId, startUnix, endUnix);

  // 3) submitted
  const submitters = [];
  for (const msg of messages) {
    const uid = extractSubmitterUserId(msg);
    if (uid) submitters.push(uid);
  }

  // 対象者に含まれる提出だけ採用（関係者以外のメンション混入を除外）
  const submittedUserIds = uniq(submitters).filter((u) => targetsSet.has(u));
  const submittedSet = new Set(submittedUserIds);

  // 4) missing = targets - submitted
  const missingUserIds = targetUserIds.filter((u) => !submittedSet.has(u));

  console.log(`[${label}] result`, {
    targets: targetUserIds.length,
    messages: messages.length,
    submitted: submittedUserIds.length,
    missing: missingUserIds.length
  });

  // 5) notify (各日報チャンネルへ)
  await postAdminSummaryThreaded({
    channelId: reportChannelId,
    label,
    now,
    targetsCount: targetUserIds.length,
    submittedCount: submittedUserIds.length,
    missingUserIds,
    workflowUrl
  });
}

/**
 * Scheduling
 * node-cron supports timezone option.
 */
function scheduleJobs() {
  // 退勤: 毎日 CUTOFF_TIME_OUT JST
  cron.schedule(
    `${parseInt(CUTOFF_TIME_OUT.split(":")[1], 10)} ${parseInt(CUTOFF_TIME_OUT.split(":")[0], 10)} * * *`,
    async () => {
      try {
        await runCheck({
          label: "退勤",
          reportChannelId: REPORT_CHANNEL_OUT,
          cutoffTime: CUTOFF_TIME_OUT,
          workflowUrl: WORKFLOW_URL_OUT
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
            workflowUrl: WORKFLOW_URL_IN
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
    hasIn: !!REPORT_CHANNEL_IN
  });
}

/**
 * Main
 */
(async () => {
  console.log("daily-report-watcher boot", { TZ, RUN_ON_BOOT });

  scheduleJobs();

  if (RUN_ON_BOOT) {
    // 起動テスト（退勤）
    try {
      await runCheck({
        label: "退勤(起動テスト)",
        reportChannelId: REPORT_CHANNEL_OUT,
        cutoffTime: CUTOFF_TIME_OUT,
        workflowUrl: WORKFLOW_URL_OUT
      });
    } catch (e) {
      console.error("[起動テスト] error", e);
    }
  }
})();
