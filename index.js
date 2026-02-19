import { App } from "@slack/bolt";
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

const USERGROUP_ID = process.env.USERGROUP_ID;
const NOTIFY_CHANNEL = process.env.NOTIFY_CHANNEL;

// 退勤
const REPORT_CHANNEL_OUT = process.env.REPORT_CHANNEL_OUT;
const CUTOFF_TIME_OUT = process.env.CUTOFF_TIME_OUT || "00:30";
const WORKFLOW_URL_OUT = process.env.WORKFLOW_URL_OUT || "";

// 出勤（任意）
const REPORT_CHANNEL_IN = process.env.REPORT_CHANNEL_IN || "";
const CUTOFF_TIME_IN = process.env.CUTOFF_TIME_IN || "12:00";
const WORKFLOW_URL_IN = process.env.WORKFLOW_URL_IN || "";

// 初回テスト用（trueなら起動直後に1回チェック）
const RUN_ON_BOOT = (process.env.RUN_ON_BOOT || "").toLowerCase() === "true";

if (!BOT_TOKEN) throw new Error("Missing env: SLACK_BOT_TOKEN");
if (!USERGROUP_ID) throw new Error("Missing env: USERGROUP_ID");
if (!NOTIFY_CHANNEL) throw new Error("Missing env: NOTIFY_CHANNEL");
if (!REPORT_CHANNEL_OUT) throw new Error("Missing env: REPORT_CHANNEL_OUT");

/**
 * Bolt (Eventsは受けない / Web APIクライアントとして利用)
 */
const app = new App({
  token: BOT_TOKEN
});

const client = app.client;

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

function formatMentions(userIds) {
  return userIds.map((u) => `<@${u}>`).join(" ");
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

async function postAdminSummary({ label, now, targetsCount, submittedCount, missingUserIds, workflowUrl }) {
  const missingCount = missingUserIds.length;
  const missingMentions = formatMentions(missingUserIds);

  const text =
`🕒 ${label} チェック結果（${now.format("YYYY-MM-DD HH:mm")} 時点）

対象：${targetsCount}
検出：${submittedCount}
未検出（未提出候補）：${missingCount}

⚠️ 未検出一覧：
${missingCount ? missingMentions : "なし 🎉"}

提出はこちら 👉 ${workflowUrl || "（URL未設定）"}
※欠勤/休暇者が含まれる可能性があります。勤務者のみに絞って手動フォローしてください。`;

  await client.chat.postMessage({
    channel: NOTIFY_CHANNEL,
    text
  });
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

  // 5) notify
  await postAdminSummary({
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
  // 退勤: 毎日 00:30 JST
  cron.schedule(
    `${parseInt(CUTOFF_TIME_OUT.split(":")[1], 10)} ${parseInt(CUTOFF_TIME_OUT.split(":")[0], 10)} * * *`,
    async () => {
      try {
        await runCheck({
          label: "退勤日報",
          reportChannelId: REPORT_CHANNEL_OUT,
          cutoffTime: CUTOFF_TIME_OUT,
          workflowUrl: WORKFLOW_URL_OUT
        });
      } catch (e) {
        console.error("[退勤日報] job error", e);
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
            label: "出勤日報",
            reportChannelId: REPORT_CHANNEL_IN,
            cutoffTime: CUTOFF_TIME_IN,
            workflowUrl: WORKFLOW_URL_IN
          });
        } catch (e) {
          console.error("[出勤日報] job error", e);
        }
      },
      { timezone: TZ }
    );
  }

  console.log("cron scheduled", { TZ, CUTOFF_TIME_OUT, CUTOFF_TIME_IN, hasIn: !!REPORT_CHANNEL_IN });
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
        label: "退勤日報(起動テスト)",
        reportChannelId: REPORT_CHANNEL_OUT,
        cutoffTime: CUTOFF_TIME_OUT,
        workflowUrl: WORKFLOW_URL_OUT
      });
    } catch (e) {
      console.error("[起動テスト] error", e);
    }
  }
})();
