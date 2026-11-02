// Handover: while Claude is at its usage limit, a Claude Code chat continues in OpenCode (whose
// free models work only inside OpenCode), and goes back to Claude Code once the limit resets.
// The two agents keep separate sessions, so each switch carries a summary of the other side.

export const HANDOVER_MODEL = 'opencode/glm-5.3-flash-free';

/** Claude's state from cc-fallback's status: limited while the proxy has it paused for a limit. */
export function claudeLimit(status) {
  const c = status?.up && status.providers?.find((p) => p.name === 'claude');
  return c?.pausedFor && /limit/i.test(c.reason || '') ? { limited: true, backIn: c.pausedFor } : { limited: false };
}

/** UI history items -> a compact plain-text transcript, most recent kept when it is too long. */
export function transcript(items, maxChars = 12000) {
  const lines = [];
  for (const it of items) {
    if (it.type === 'user') lines.push(`User: ${it.text}`);
    else if (it.type === 'text') lines.push(`Assistant: ${it.text}`);
    else if (it.type === 'tool_use') {
      const i = it.input || {};
      const what = i.command || i.file_path || i.filePath || i.path || i.pattern || i.url || '';
      lines.push(`[assistant used ${it.name}${what ? `: ${String(what).split('\n')[0].slice(0, 160)}` : ''}]`);
    } else if (it.type === 'tool_result' && it.isError) lines.push(`[that tool failed: ${String(it.text).slice(0, 160)}]`);
  }
  let text = lines.join('\n');
  if (text.length > maxChars) text = `[…earlier part left out…]\n${text.slice(-maxChars)}`;
  return text;
}

export function handoverPrompt({ to, cwd, history, prompt }) {
  const other = to === 'opencode' ? 'Claude Code' : 'OpenCode';
  const why = to === 'opencode'
    ? `${other} is unavailable right now (the user's Claude usage limit is reached), so you are taking over.`
    : `You are back after a usage-limit pause; meanwhile ${other} continued the work.`;
  return [
    `This chat is being continued from another coding assistant (${other}). ${why}`,
    `Working folder: ${cwd}. Check the files themselves before relying on this summary.`,
    history ? `Conversation so far (most recent last):\n---\n${history}\n---` : '',
    `The user's new message:\n${prompt}`,
  ].filter(Boolean).join('\n\n');
}
