import { describe, expect, it } from 'vitest';
import { HELPER_SCRIPT } from '../src/main/computer/helper.js';

describe('desktop helper overhaul contract', () => {
  it('does not reintroduce the fixed focus and per-action sleeps', () => {
    expect(HELPER_SCRIPT).not.toContain('Start-Sleep -Milliseconds 120');
    expect(HELPER_SCRIPT).not.toContain('Start-Sleep -Milliseconds 30');
    expect(HELPER_SCRIPT).not.toContain('Start-Sleep -Milliseconds 20');
    expect(HELPER_SCRIPT).toContain('Stopwatch]::StartNew()');
  });

  it('keeps observation coalesced and window capture background-first', () => {
    expect(HELPER_SCRIPT).toContain("'snapshot'");
    expect(HELPER_SCRIPT).toContain('[CosWindowsCapture]::Capture');
    expect(HELPER_SCRIPT).not.toContain('PrintWindow');
    expect(HELPER_SCRIPT).not.toContain("$mode = 'screen_fallback'");
    expect(HELPER_SCRIPT).toContain("$mode = 'window'");
    expect(HELPER_SCRIPT).not.toContain('$root.FindAll(');
    expect(HELPER_SCRIPT).toContain('TreeWalker]::ControlViewWalker');
    expect(HELPER_SCRIPT).toContain('System.Windows.Automation.CacheRequest');
  });

  it('returns exact partial-batch evidence and snapshot-scopes UI handles', () => {
    expect(HELPER_SCRIPT).toContain('completed_count = $completed');
    expect(HELPER_SCRIPT).toContain('failed_index = $index');
    expect(HELPER_SCRIPT).toContain('$script:UiSnapshots');
    expect(HELPER_SCRIPT).toContain('STALE_UI_SNAPSHOT');
  });

  it('keeps model-driven pointer motion visible without replacing the system cursor', () => {
    expect(HELPER_SCRIPT).toContain('public static class CursorGlow');
    expect(HELPER_SCRIPT).toContain('CursorGlow.ShowAt(x, y, false)');
    expect(HELPER_SCRIPT).toContain('double eased = t * t * (3.0 - 2.0 * t)');
    expect(HELPER_SCRIPT).toContain('Math.Min(95, Math.Max(35');
    expect(HELPER_SCRIPT).toContain('public static void MoveVisible(int x, int y)');
    expect(HELPER_SCRIPT).toContain("'click'        { [Clf]::ClickVisible");
    expect(HELPER_SCRIPT).not.toContain('SetSystemCursor');
    expect(HELPER_SCRIPT).not.toContain('SystemParametersInfo');
  });

  it('keeps the model-visible capture free of its own cursor glow', () => {
    expect(HELPER_SCRIPT).toContain('public static void HideForCapture()');
    expect(HELPER_SCRIPT).toContain('[CursorGlow]::HideForCapture()');
  });

  it('has a disk-free visual fingerprint path for cheap change detection', () => {
    expect(HELPER_SCRIPT).toContain('public static string FrameHash(');
    expect(HELPER_SCRIPT).toContain("'framehash'");
    expect(HELPER_SCRIPT).toContain('$result.hash = [Clf]::FrameHash');
    expect(HELPER_SCRIPT).toContain('$result.beforeHash = [Clf]::FrameHash');
    expect(HELPER_SCRIPT).toContain('$result.afterHash = [Clf]::FrameHash');
  });

  it('can capture the immediate result inside the native action request', () => {
    expect(HELPER_SCRIPT).toContain('$request.captureAfter');
    expect(HELPER_SCRIPT).toContain('$result.capture = Capture-Target $request.captureAfter $null');
    expect(HELPER_SCRIPT).toContain("error_code = 'CAPTURE_AFTER_FAILED'");
  });
});
