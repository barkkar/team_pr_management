"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
require("dotenv/config");
const web_api_1 = require("@slack/web-api");
const client_1 = require("../src/db/client");
async function fetchBotThreadReply(slack, channelId, parentTs) {
    const resp = await slack.conversations.replies({ channel: channelId, ts: parentTs, limit: 50 });
    if (!resp.ok || !resp.messages)
        return null;
    for (const m of resp.messages) {
        if (m.ts === parentTs)
            continue;
        if (!m.bot_id && m.subtype !== 'bot_message')
            continue;
        const text = m.text || '';
        if (!/reviewer/i.test(text) && !/<@/.test(text))
            continue;
        const userIds = [];
        const blocksAny = m.blocks;
        const re = /<@([UW][A-Z0-9]+)>/g;
        if (Array.isArray(blocksAny)) {
            const json = JSON.stringify(blocksAny);
            let match;
            while ((match = re.exec(json)) !== null)
                userIds.push(match[1]);
        }
        if (userIds.length === 0) {
            let match;
            while ((match = re.exec(text)) !== null)
                userIds.push(match[1]);
        }
        return { userIds: [...new Set(userIds)] };
    }
    return null;
}
async function main() {
    const required = ['SLACK_BOT_TOKEN', 'DATABASE_URL'];
    const missing = required.filter((k) => !process.env[k]);
    if (missing.length > 0) {
        console.error('Missing env: ' + missing.join(', '));
        process.exit(1);
    }
    const slack = new web_api_1.WebClient(process.env.SLACK_BOT_TOKEN);
    const prs = (await client_1.pool.query("SELECT pr_url, channel_id, message_ts FROM tracked_prs WHERE suggestions_sent = TRUE ORDER BY channel_id, created_at")).rows;
    const memberCache = new Map();
    async function membersFor(channelId) {
        if (memberCache.has(channelId))
            return memberCache.get(channelId);
        const r = await client_1.pool.query("SELECT slack_user_id FROM channel_bootstrap_members WHERE channel_id=$1 AND status='resolved'", [channelId]);
        const set = new Set(r.rows.map((row) => row.slack_user_id));
        memberCache.set(channelId, set);
        return set;
    }
    let auditedTotal = 0;
    let outsiderTotal = 0;
    const perChannel = new Map();
    for (const pr of prs) {
        let reply = null;
        try {
            reply = await fetchBotThreadReply(slack, pr.channel_id, pr.message_ts);
        }
        catch (err) {
            console.error('  ' + pr.pr_url + ': replies error — ' + err.message);
            continue;
        }
        if (!reply || reply.userIds.length === 0)
            continue;
        auditedTotal++;
        const members = await membersFor(pr.channel_id);
        const inside = reply.userIds.filter((id) => members.has(id));
        const outside = reply.userIds.filter((id) => !members.has(id));
        outsiderTotal += outside.length;
        const stats = perChannel.get(pr.channel_id) || { audited: 0, clean: 0, mixed: 0, allOutside: 0, outsiders: new Set() };
        stats.audited++;
        if (outside.length === 0)
            stats.clean++;
        else if (inside.length === 0)
            stats.allOutside++;
        else
            stats.mixed++;
        for (const o of outside)
            stats.outsiders.add(o);
        perChannel.set(pr.channel_id, stats);
        const status = outside.length === 0 ? 'OK' : (inside.length === 0 ? 'ALL_OUTSIDE' : 'MIXED');
        console.log('[' + status + '] ' + pr.channel_id + ' ' + pr.pr_url + ' | total=' + reply.userIds.length + ' inside=' + inside.length + ' outside=' + outside.length + (outside.length ? ' [' + outside.join(',') + ']' : ''));
    }
    console.log('\n=== Per-channel summary ===');
    for (const [channelId, s] of perChannel) {
        console.log(channelId + ': audited=' + s.audited + ' ok=' + s.clean + ' mixed=' + s.mixed + ' all_outside=' + s.allOutside + ' unique_outsiders=' + s.outsiders.size);
    }
    console.log('\nTotal PRs audited: ' + auditedTotal);
    console.log('Total suggestion outsiders: ' + outsiderTotal);
    await client_1.pool.end();
}
main().catch((err) => { console.error(err); process.exit(1); });
//# sourceMappingURL=auditPastSuggestions.js.map