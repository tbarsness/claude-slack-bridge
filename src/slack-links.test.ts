import { test } from "node:test";
import assert from "node:assert/strict";
import { parseSlackPermalinks, slackLinksForPrompt } from "./slack-links.js";

const LINK = "https://fjorge.slack.com/archives/C056298P54H/p1794869803037839";

/** A fake fetch that answers Slack Web API calls from a method -> body map. */
function fakeSlack(bodies: Record<string, unknown>, calls: string[] = []): typeof fetch {
  return (async (input: string | URL | Request) => {
    const url = new URL(String(input));
    calls.push(`${url.pathname.slice(5)}?${url.searchParams}`);
    const body = bodies[url.pathname.slice(5)] ?? { ok: false, error: "unknown_method" };
    return new Response(JSON.stringify(body), { headers: { "content-type": "application/json" } });
  }) as typeof fetch;
}

test("parseSlackPermalinks turns a permalink into a channel and ts", () => {
  assert.deepEqual(parseSlackPermalinks(`see ${LINK} please`), [
    { url: LINK, channel: "C056298P54H", ts: "1794869803.037839" },
  ]);
});

test("parseSlackPermalinks keeps thread_ts on a reply link", () => {
  const reply = `${LINK}?thread_ts=1794869000.000100&cid=C056298P54H`;
  assert.deepEqual(parseSlackPermalinks(reply), [
    { url: reply, channel: "C056298P54H", ts: "1794869803.037839", threadTs: "1794869000.000100" },
  ]);
});

test("parseSlackPermalinks reads a link the board wrapped in markdown", () => {
  assert.equal(parseSlackPermalinks(`[the thread](${LINK})`).length, 1);
});

test("parseSlackPermalinks ignores other hosts and repeats", () => {
  assert.deepEqual(parseSlackPermalinks("https://example.com/archives/C1/p1794869803037839"), []);
  assert.equal(parseSlackPermalinks(`${LINK} ${LINK}`).length, 1);
});

test("slackLinksForPrompt puts the linked thread's text in the prompt", async () => {
  const calls: string[] = [];
  const fetchImpl = fakeSlack(
    {
      "conversations.replies": {
        ok: true,
        messages: [
          { user: "U1", ts: "1794869803.037839", text: "2027 budget is $4.2M" },
          { user: "U2", ts: "1794869900.000200", text: "agreed" },
        ],
      },
      "users.info": { ok: true, user: { real_name: "Mary" } },
    },
    calls,
  );
  const block = await slackLinksForPrompt(`look at ${LINK}`, "xoxp-test", fetchImpl);
  assert.match(block, /2027 budget is \$4\.2M/);
  assert.match(block, /Mary: agreed/);
  assert.ok(calls.some((c) => c.startsWith("conversations.replies?channel=C056298P54H&ts=1794869803.037839")));
});

test("slackLinksForPrompt reads the whole thread for a reply link", async () => {
  const calls: string[] = [];
  const fetchImpl = fakeSlack({ "conversations.replies": { ok: true, messages: [] } }, calls);
  await slackLinksForPrompt(`${LINK}?thread_ts=1794869000.000100`, "xoxp-test", fetchImpl);
  assert.ok(calls.some((c) => c.includes("ts=1794869000.000100")));
});

test("slackLinksForPrompt keeps a linked reply past the first page and says the thread was cut", async () => {
  const calls: string[] = [];
  const fetchImpl = (async (input: string | URL | Request) => {
    const url = new URL(String(input));
    calls.push(String(url.searchParams));
    const messages = url.searchParams.has("oldest")
      ? [{ user: "U1", ts: "1794869803.037839", text: "the reply Tim linked" }]
      : [{ user: "U1", ts: "1794869000.000100", text: "thread root" }];
    return Response.json({ ok: true, messages, has_more: !url.searchParams.has("oldest") });
  }) as typeof fetch;
  const block = await slackLinksForPrompt(`${LINK}?thread_ts=1794869000.000100`, "xoxp-test", fetchImpl);
  assert.match(block, /\(linked message\) U1: the reply Tim linked/);
  assert.match(block, /thread truncated/);
  assert.ok(calls.some((c) => c.includes("oldest=1794869803.037839") && c.includes("inclusive=true")));
});

test("slackLinksForPrompt reads several links at once, not one after another", async () => {
  let inFlight = 0;
  let peak = 0;
  const fetchImpl = (async () => {
    peak = Math.max(peak, ++inFlight);
    await new Promise((r) => setTimeout(r, 20));
    inFlight--;
    return Response.json({ ok: true, messages: [] });
  }) as typeof fetch;
  const other = "https://fjorge.slack.com/archives/C0000000001/p1794869803037840";
  await slackLinksForPrompt(`${LINK} ${other}`, "xoxp-test", fetchImpl);
  assert.equal(peak, 2);
});

test("slackLinksForPrompt reports a failed read instead of throwing", async () => {
  const fetchImpl = fakeSlack({ "conversations.replies": { ok: false, error: "channel_not_found" } });
  const block = await slackLinksForPrompt(LINK, "xoxp-test", fetchImpl);
  assert.match(block, /could not be read/);
  assert.match(block, /channel_not_found/);
});

test("slackLinksForPrompt says why when there is no token", async () => {
  const block = await slackLinksForPrompt(LINK, undefined, fakeSlack({}));
  assert.match(block, /SLACK_USER_TOKEN/);
});

test("slackLinksForPrompt adds nothing when there is no Slack link", async () => {
  assert.equal(await slackLinksForPrompt("no links here", "xoxp-test", fakeSlack({})), "");
});
