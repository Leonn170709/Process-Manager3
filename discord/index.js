'use strict';

// Optional Discord control panel. Dormant unless BOTH `discordToken` and
// `discordChannel` are set in ~/.pm3/config.json.
//
// Security model, in full: anyone who can post in the whitelisted channel can
// start, stop and read the logs of every managed process. There is no per-user
// check - the channel *is* the ACL, so point it at a private channel.

const os = require('os');
const storage = require('../storage');
const pm = require('../core/processManager');
const userConfig = require('../config/userConfig');
const { STATUS } = require('../config/constants');

const FOOTER = 'PM3 control panel';
const REFRESH_MS = 15000;
const LOG_LINES = 40;
const MAX_OPTIONS = 25;          // Discord's hard cap on select-menu options

const EMOJI = {
  [STATUS.RUNNING]:    '🟢',
  [STATUS.STARTING]:   '🟡',
  [STATUS.RESTARTING]: '🟠',
  [STATUS.CRASHED]:    '🔴',
  [STATUS.STOPPED]:    '⚫',
};

let client = null;
let panelMsg = null;
let lastRender = '';

// ── formatting ────────────────────────────────────────────────

function fmtUptime(s) {
  if (!s || s < 60) return `${Math.max(0, Math.floor(s || 0))}s`;
  const d = Math.floor(s / 86400), h = Math.floor((s % 86400) / 3600), m = Math.floor((s % 3600) / 60);
  return d ? `${d}d ${h}h` : h ? `${h}h ${m}m` : `${m}m`;
}

function fmtBytes(b) {
  const g = b / 1024 ** 3;
  return g >= 1 ? `${g.toFixed(1)}GB` : `${Math.round(b / 1024 ** 2)}MB`;
}

function procLine(p) {
  const cols = [
    (EMOJI[p.status] || '⚪') + ' `' + p.name + '`',
    `${(p.cpu || 0).toFixed(1)}%`,
    `${p.memory || 0}MB`,
    fmtUptime(p.uptime),
    p.restartCount ? `↻${p.restartCount}` : '',
  ];
  return cols.filter(Boolean).join(' · ');
}

// ── panel ─────────────────────────────────────────────────────

function buildPanel(d) {
  const procs = Object.values(pm.getAllProcesses());
  const running = procs.filter(p => p.status === STATUS.RUNNING).length;
  const shown = procs.slice(0, MAX_OPTIONS);

  const embed = new d.EmbedBuilder()
    .setTitle('⚡ PM3')
    .setColor(procs.some(p => p.status === STATUS.CRASHED) ? 0xef4444 : 0x5865f2)
    .setDescription(procs.length ? procs.map(procLine).join('\n') : '_No processes._')
    .addFields({
      name: 'Host',
      value: `load ${os.loadavg()[0].toFixed(2)} · RAM ${fmtBytes(os.totalmem() - os.freemem())}/${fmtBytes(os.totalmem())} · up ${fmtUptime(os.uptime())}`,
    })
    .setFooter({ text: `${FOOTER} · ${running}/${procs.length} running` })
    .setTimestamp();

  const rows = [];
  if (shown.length) {
    rows.push(new d.ActionRowBuilder().addComponents(
      new d.StringSelectMenuBuilder()
        .setCustomId('pm3:sel')
        .setPlaceholder('Select a process to control…')
        // Values and customIds carry the numeric id, not the name: Discord caps both at
        // 100 chars and resolveProcess() takes either, so a long name cannot break a button.
        .addOptions(shown.map(p => ({
          label: p.name.slice(0, 100),
          value: String(p.id),
          description: `${p.status} · ${p.memory || 0}MB`.slice(0, 100),
          emoji: EMOJI[p.status] || '⚪',
        })))
    ));
  }
  rows.push(new d.ActionRowBuilder().addComponents(
    new d.ButtonBuilder().setCustomId('pm3:refresh').setLabel('Refresh').setStyle(d.ButtonStyle.Secondary).setEmoji('🔄')
  ));

  return { embeds: [embed], components: rows };
}

function procPanel(d, p) {
  const embed = new d.EmbedBuilder()
    .setTitle(`${EMOJI[p.status] || '⚪'} ${p.name}`)
    .setColor(p.status === STATUS.RUNNING ? 0x22c55e : p.status === STATUS.CRASHED ? 0xef4444 : 0x6b7280)
    .addFields(
      { name: 'Status',  value: `${p.status}${p.exitCode != null ? ` (exit ${p.exitCode})` : ''}`, inline: true },
      { name: 'PID',     value: String(p.pid || '-'), inline: true },
      { name: 'Uptime',  value: fmtUptime(p.uptime), inline: true },
      { name: 'CPU',     value: `${(p.cpu || 0).toFixed(1)}%`, inline: true },
      { name: 'RAM',     value: `${p.memory || 0}MB${p.memoryLimit > 0 ? ` / ${p.memoryLimit}MB` : ''}`, inline: true },
      { name: 'Restarts', value: `${p.restartCount || 0} / ${p.maxRestarts === -1 ? '∞' : p.maxRestarts}`, inline: true },
      { name: 'Script',  value: '```' + String(p.script).slice(0, 200) + '```' },
    );

  const btn = (action, label, style, emoji) =>
    new d.ButtonBuilder().setCustomId(`pm3:${action}:${p.id}`).setLabel(label).setStyle(style).setEmoji(emoji);

  return {
    embeds: [embed],
    components: [new d.ActionRowBuilder().addComponents(
      btn('restart', p.status === STATUS.RUNNING ? 'Restart' : 'Start', d.ButtonStyle.Success, '▶️'),
      btn('stop', 'Stop', d.ButtonStyle.Danger, '⏹️'),
      btn('logs', 'Logs', d.ButtonStyle.Primary, '📄'),
      btn('view', 'Refresh', d.ButtonStyle.Secondary, '🔄'),
    )],
  };
}

function tailLogs(name) {
  const lines = [storage.readLog(name, 'out', LOG_LINES), storage.readLog(name, 'err', LOG_LINES)]
    .join('\n').split('\n').filter(Boolean).sort().slice(-LOG_LINES);
  if (!lines.length) return '_No log output._';
  // 2000-char message cap; keep the newest lines and drop from the top.
  let out = lines.join('\n');
  if (out.length > 1900) out = '…\n' + out.slice(out.length - 1899);
  return '```\n' + out + '\n```';
}

// ── interactions ──────────────────────────────────────────────

async function handle(d, i) {
  if (i.channelId !== userConfig.get('discordChannel')) {
    return i.reply({ content: 'PM3 is not enabled in this channel.', flags: d.MessageFlags.Ephemeral });
  }

  const id = i.customId || '';
  if (id === 'pm3:refresh') return i.update(buildPanel(d));
  if (id === 'pm3:sel') {
    const name = pm.resolveProcess(i.values[0]);
    if (!name) return i.reply({ content: 'Process not found.', flags: d.MessageFlags.Ephemeral });
    return i.reply({ ...procPanel(d, pm.getProcessInfo(name)), flags: d.MessageFlags.Ephemeral });
  }

  const m = id.match(/^pm3:(restart|stop|logs|view):(.+)$/s);
  if (!m) return;
  const [, action, raw] = m;
  const name = pm.resolveProcess(raw);
  if (!name) return i.reply({ content: `Process \`${raw}\` not found.`, flags: d.MessageFlags.Ephemeral });

  if (action === 'logs') {
    return i.reply({ content: `**${name}** — last ${LOG_LINES} lines\n${tailLogs(name)}`, flags: d.MessageFlags.Ephemeral });
  }
  if (action === 'restart') pm.restartProcess(name);
  if (action === 'stop') pm.stopProcess(name);

  // The record is written synchronously by stop/restart, so re-reading it here
  // already shows the new status.
  await i.update(procPanel(d, pm.getProcessInfo(name)));
  refresh().catch(() => {});
}

// ── lifecycle ─────────────────────────────────────────────────

async function refresh() {
  if (!panelMsg || !client) return;
  const d = require('discord.js');
  const payload = buildPanel(d);
  const render = JSON.stringify(payload.embeds[0].toJSON().description) + payload.embeds[0].toJSON().footer.text;
  if (render === lastRender) return;      // ponytail: skip no-op edits, cheapest rate-limit guard there is
  lastRender = render;
  await panelMsg.edit(payload);
}

function start() {
  const token = userConfig.get('discordToken');
  const channelId = userConfig.get('discordChannel');
  if (!token || !channelId) return;

  let d;
  try {
    d = require('discord.js');
  } catch (err) {
    console.error('[PM3] discord.js is not installed - Discord panel disabled:', err.message);
    return;
  }

  client = new d.Client({ intents: [d.GatewayIntentBits.Guilds] });

  client.once('clientReady', async () => {
    console.log(`[PM3] Discord bot connected as ${client.user.tag}`);
    try {
      const ch = await client.channels.fetch(channelId);
      // Reuse our own last panel instead of spamming a new one on every daemon restart.
      const recent = await ch.messages.fetch({ limit: 20 });
      panelMsg = recent.find(msg =>
        msg.author.id === client.user.id && msg.embeds[0]?.footer?.text?.startsWith(FOOTER)) || null;
      if (panelMsg) await panelMsg.edit(buildPanel(d));
      else panelMsg = await ch.send(buildPanel(d));
      lastRender = '';
    } catch (err) {
      console.error('[PM3] Discord panel setup failed:', err.message);
    }
  });

  client.on('interactionCreate', async i => {
    if (!i.isButton() && !i.isStringSelectMenu()) return;
    try {
      await handle(d, i);
    } catch (err) {
      console.error('[PM3] Discord interaction failed:', err.message);
      if (!i.replied && !i.deferred) i.reply({ content: `Error: ${err.message}`, flags: d.MessageFlags.Ephemeral }).catch(() => {});
    }
  });

  client.on('error', err => console.error('[PM3] Discord client error:', err.message));
  client.login(token).catch(err => console.error('[PM3] Discord login failed:', err.message));

  setInterval(() => refresh().catch(() => {}), REFRESH_MS).unref();
}

module.exports = { start, _internal: { fmtUptime, fmtBytes, procLine, tailLogs, buildPanel, procPanel } };
