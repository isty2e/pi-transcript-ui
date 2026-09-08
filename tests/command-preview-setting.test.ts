import { expect, it } from "vitest";
import { NO_SUMMARY_METRICS } from "../src/tool-metrics.js";
import { stripTerminalSequences, truncateToWidth, visibleWidth } from "@earendil-works/pi-tui";
import { commandPreview } from "../src/command-preview.js";
import { displayFor, targetText, settledLine, joinLine } from "../src/display.js";
import { defaultSettings, parseSettings } from "../src/settings.js";

const command = 'cd /Users/example/' + 'long-directory/'.repeat(12) + 'project && git status';
it.each([null, true, 1, {}, "Raw", "auto"])("rejects invalid command preview mode %j", mode => {
  expect(() => parseSettings({ ...defaultSettings(), display: { commandPreview: mode } })).toThrow();
});
it("defaults old settings to Compact without changing the supplied object", () => {
  const old = { ...defaultSettings(), display: { rowMaxWidth: 96, commandMaxWidth: 80, intentMaxWidth: 32 } };
  const original = JSON.stringify(old);
  expect(parseSettings(old).display).toEqual({ ...old.display, commandPreview: 'compact' });
  expect(JSON.stringify(old)).toBe(original);
  expect(parseSettings({ ...old, display: { ...old.display, commandPreview: 'raw' } }).display.commandPreview).toBe('raw');
});
it("uses canonical raw first-line fallback at every width without compact transformations", () => {
  const source = `ENV=value\t${command}\r\necho next-line`;
  const first = source.split('\n')[0]!.replace(/[\r\t]/g, ' ');
  for (let width = 0; width <= 180; width++) {
    expect(commandPreview(source, width, 'bash', 'raw')).toBe(truncateToWidth(first, width, '…'));
    expect(visibleWidth(commandPreview(source, width, 'bash', 'raw'))).toBeLessThanOrEqual(width);
  }
  expect(commandPreview(command, 60)).toContain('git status');
  expect(commandPreview(command, 60, 'bash', 'raw')).not.toContain('git status');
  expect(commandPreview(source, 60, 'powershell', 'compact')).toBe(commandPreview(source, 60, 'powershell', 'raw'));
});
it("applies mode at both preliminary and final row allocation while retaining source args", () => {
  const display = displayFor('bash', { command })!;
  expect(targetText(display.target, { commandMaxWidth: 60, commandPreview: 'raw' })).toBe(truncateToWidth(command, 60, '…'));
  for (const width of [12, 48, 80, 180]) {
    const raw = joinLine(settledLine({ toolName: 'bash', display, content: [], isError: false, intent: 'purpose', layout: { width, limits: { commandPreview: 'raw' } }, metrics: NO_SUMMARY_METRICS }));
    expect(visibleWidth(raw)).toBeLessThanOrEqual(Math.min(width, 120));
    expect(stripTerminalSequences(raw)).not.toContain('git status');
  }
  expect(display.target).toEqual({ kind: 'command', command });
});
