# PRD: Reduce Memory Usage in Recordly

**Author:** Gurpreet Kait  
**Date:** 2026-05-09  
**Branch:** `refactor/reduce-memory-usage`  
**Status:** Draft

---

## 1. Why This Matters

When a user records their screen for 20+ minutes or exports a long video at high resolution, Recordly's memory usage climbs steadily. On machines with 8 GB of RAM, this can cause the system to slow down, show memory warnings, or in worst cases crash the app entirely.

The root cause is not one big leak — it's several small things adding up: log strings that grow forever, arrays that hold duplicate data, canvases that aren't freed after use, and decode buffers sized too generously for the hardware.

This PRD documents the specific issues found, what we plan to fix, and what we're leaving for later.

---

## 2. Goals

- Users should be able to record for 30+ minutes without the app getting sluggish
- Exporting a 10-minute 1080p video should not spike memory to multiple GB
- After an export finishes, memory should drop back to baseline (no lingering waste)
- Zero changes to output quality or features — this is purely internal cleanup

## 3. Non-Goals

- Rewriting the rendering engine or export pipeline
- Optimizing CPU usage or disk I/O
- Reducing memory of the video preview/editor (future work)

---

## 4. Current Issues Identified

We audited the full recording and export pipelines. Below are the real memory problems we found, ordered by how much memory they waste in practice.

### Issue 1: Audio decode temporarily doubles memory for long recordings

**When it happens:** Every time a user exports a recording that has audio (which is almost always).

**What goes wrong:** When preparing audio for export, Recordly decodes the full audio track into small chunks, then copies all those chunks into a single final buffer. During the copy step, both the chunks and the final buffer exist in memory at the same time — temporarily doubling the audio memory.

**Real-world impact:**  
- 5-minute recording: ~55 MB wasted (110 MB peak instead of 55 MB)  
- 10-minute recording: ~220 MB wasted (440 MB peak instead of 220 MB)  
- 30-minute recording: ~660 MB wasted (1.3 GB peak instead of 660 MB)

**Where:** `src/lib/exporter/audioEncoder.ts` — the `streamDecodeFromUrl()` method holds `channelChunks[][]` and the final `AudioBuffer` simultaneously.

---

### Issue 2: Recording logs grow without limit

**When it happens:** During every screen recording, especially long ones.

**What goes wrong:** Recordly spawns a native helper process (on macOS, Windows, or via FFmpeg) to capture the screen. The stdout and stderr output from these processes is stored in string variables that grow for the entire duration of the recording. These logs are only useful for error diagnostics, but they're never trimmed.

**Real-world impact:** A 1-hour recording with a verbose capture helper can accumulate 2-5 MB of log strings per process. With both stdout and stderr, and sometimes multiple processes (capture + cursor monitor), this can reach 10+ MB of strings sitting in the main process memory doing nothing.

**Where:**  
- macOS: `electron/ipc/register/recording.ts` — `nativeCaptureOutputBuffer`
- Windows: same file — `windowsCaptureOutputBuffer` via local `captureOutput`
- FFmpeg: same file — `ffmpegCaptureOutputBuffer`

---

### Issue 3: FFmpeg export logs grow without limit

**When it happens:** During every native (Breeze) video export.

**What goes wrong:** Same pattern as Issue 2, but during export instead of recording. FFmpeg's stderr output is appended to a string (`session.stderrOutput`) for the entire duration of the export with no cap.

**Real-world impact:** A 30-minute 4K export can produce 1-3 MB of FFmpeg log output. Not huge on its own, but it adds up alongside all the other export memory.

**Where:** `electron/ipc/register/export.ts` — the `stderrOutput` field on `NativeVideoExportSession`.

---

### Issue 4: Cursor tracking data is duplicated in memory

**When it happens:** During any recording longer than a few minutes.

**What goes wrong:** Recordly samples cursor position 30 times per second during recording. Periodically, these samples are "snapshotted" for persistence — copied from an `activeCursorSamples` array into a `pendingCursorSamples` array. But the active array is never cleared after the copy, so both arrays hold the same data.

**Real-world impact:**  
- 10-minute recording: ~18K samples duplicated = ~3.4 MB wasted  
- 30-minute recording: ~54K samples duplicated = ~10 MB wasted

**Where:** `electron/ipc/cursor/telemetry.ts` — `snapshotCursorTelemetryForPersistence()` copies but doesn't clear `activeCursorSamples`.

---

### Issue 5: Export canvases not fully cleaned up after export

**When it happens:** After every video export finishes.

**What goes wrong:** The frame renderer (`FrameRenderer`) allocates several HTML canvases at the output resolution for compositing, staging video frames, and drawing backgrounds. When the export finishes and `destroy()` is called, most of these canvases are released — but four references are missed:
- `backgroundVideoFrameStagingCanvas` and its context
- `compositeCanvas` and its context

These canvases stay in memory until JavaScript's garbage collector eventually gets to them, which in Electron can take a long time.

**Real-world impact:** ~16 MB of canvas memory lingers after each 1080p export. At 4K, that's ~64 MB. If a user does multiple exports in a row, this stacks up.

**Where:** `src/lib/exporter/modernFrameRenderer.ts` — the `destroy()` method at line 3336.

---

### Issue 6: Frame capture canvas never released

**When it happens:** After the first native (Breeze) export in a session.

**What goes wrong:** The native frame capture module uses a fallback canvas for reading pixel data from the GPU. This canvas is created at the output resolution and stored in a module-level variable — meaning it lives forever once created, even after the export is done and the user goes back to editing.

**Real-world impact:** ~8 MB at 1080p, ~33 MB at 4K, persisting for the rest of the app session.

**Where:** `src/lib/exporter/nativeFrameCapture.ts` — module-level `fallbackCanvas` and `fallbackContext`.

---

### Issue 7: Too many video frames buffered on low-end machines

**When it happens:** When exporting on a machine with 4 or fewer CPU cores, or at very high resolutions (4K+).

**What goes wrong:** Recordly uses a "backpressure" system to control how many decoded video frames sit in memory waiting to be encoded. The system has a "conservative" mode for slower machines, but even this mode allows 12-20 pending frames. At high resolutions, each frame is large.

**Real-world impact:**  
- 1080p export on 4-core machine: 12 frames × ~8 MB = ~96 MB in buffers (acceptable)
- 4K export on 4-core machine: 12 frames × ~33 MB = ~396 MB in buffers (too much)

The machine is already constrained — holding this much data increases the chance of the OS swapping to disk, which makes the export even slower.

**Where:** `src/lib/exporter/exportTuning.ts` — the `breeze-conservative` and `webcodecs-conservative` profiles.

---

### Known issues NOT addressed here (future work)

These are real but require bigger changes or UX decisions:

- **Undo history has no depth limit** — Each undo snapshot in the editor stores zoom/clip region arrays. Heavy editing sessions can accumulate significant undo data. Fixing this requires deciding how many undo levels to support (UX decision).
- **Full video loaded for preview** — The editor loads the entire video for playback preview. Streaming preview would save memory but requires rearchitecting the preview pipeline.
- **Source audio buffers held during offline render** — The offline audio pipeline processes in 30-second chunks, but keeps the full decoded source audio in memory for the entire render. Streaming decode during render would fix this but adds significant complexity.

---

## 5. How Recordly Uses Memory (Simplified)

### During Recording

```
User hits Record
  └─> Spawn capture process (macOS / Windows / FFmpeg)
  └─> Sample cursor position 30x per second into an array
  └─> Capture process logs accumulate in string buffers
  └─> On Stop: save cursor data to disk, combine audio tracks
```

Memory grows linearly with recording duration via log buffers and cursor arrays.

### During Export

```
User hits Export
  └─> Decode video frames one-by-one (WebCodecs)
  └─> Render each frame with effects (PixiJS + canvases)
  └─> Encode frame (WebCodecs or FFmpeg pipe)
  └─> Decode + process audio (full track into memory)
  └─> Combine video + audio into final MP4
```

Peak memory is dominated by: decoded frame buffers, PixiJS GPU context, audio decode buffers, and staging canvases.

---

## 6. Proposed Fixes

### Fix 1: Release audio decode chunks as they're copied (Issue 1)

**What:** After copying each channel's decoded chunks into the final AudioBuffer, immediately clear the chunks array so the intermediate data can be garbage collected.

**Files:** `src/lib/exporter/audioEncoder.ts`  
**Memory saved:** Up to ~220 MB for a 10-minute recording  
**Risk:** Low — the chunks are never read again after being copied

---

### Fix 2: Cap recording log buffers at 256 KB (Issues 2)

**What:** Add a constant `MAX_CAPTURE_OUTPUT_BUFFER_LENGTH = 256 KB`. After each log append, if the buffer exceeds this limit, trim it to keep only the most recent 128 KB. We keep the tail because the most recent output is the most useful for debugging.

**Files:** `electron/ipc/constants.ts`, `electron/ipc/register/recording.ts`  
**Memory saved:** Up to several MB per long recording  
**Risk:** Very low — old log lines are only used for error diagnostics and are rarely needed

---

### Fix 3: Cap FFmpeg export stderr at 256 KB (Issue 3)

**What:** Same approach as Fix 2, applied to the FFmpeg stderr string during native export.

**Files:** `electron/ipc/register/export.ts`  
**Memory saved:** Up to several MB per long export  
**Risk:** Very low

---

### Fix 4: Clear cursor samples after snapshotting (Issue 4)

**What:** After copying active cursor samples into the pending array, set `activeCursorSamples.length = 0`. New samples will continue accumulating from scratch. The next snapshot merges only the new ones.

**Files:** `electron/ipc/cursor/telemetry.ts`  
**Memory saved:** ~10 MB for a 30-minute recording  
**Risk:** Low — verified that `activeCursorSamples` is only used for pushing new samples and for snapshotting, and is already cleared on recording stop

---

### Fix 5: Null the four missed canvas references in destroy() (Issue 5)

**What:** Add `this.backgroundVideoFrameStagingCanvas = null`, `this.backgroundVideoFrameStagingCtx = null`, `this.compositeCanvas = null`, and `this.compositeCtx = null` to the `destroy()` method.

**Files:** `src/lib/exporter/modernFrameRenderer.ts`  
**Memory saved:** ~16 MB per 1080p export, ~64 MB at 4K  
**Risk:** Very low — these are simple null assignments following the same pattern as the 20+ other canvas cleanups already in `destroy()`

---

### Fix 6: Release fallback canvas after export (Issue 6)

**What:** Add a `releaseNativeFrameCaptureResources()` function that nulls the module-level canvas and context. Call it from the exporter's cleanup method after each export.

**Files:** `src/lib/exporter/nativeFrameCapture.ts`, `src/lib/exporter/modernVideoExporter.ts`  
**Memory saved:** ~8 MB at 1080p, ~33 MB at 4K  
**Risk:** Very low — the canvas is lazily recreated on next use if needed

---

### Fix 7: Lower decode buffer limits on constrained systems (Issue 7)

**What:** Reduce the conservative backpressure profile limits:
- `breeze-conservative`: pending frames 12 → 8, decode queue 6 → 4  
- `webcodecs-conservative`: pending frames 20 → 12, decode queue 8 → 6

**Files:** `src/lib/exporter/exportTuning.ts`  
**Memory saved:** ~130 MB at 4K on a 4-core machine  
**Risk:** Low-medium — export may be slightly slower on edge-case hardware due to less pipeline buffering, but avoids the much worse scenario of the OS swapping to disk under memory pressure

---

## 7. Summary

| Fix | Addresses | Memory Saved | Risk |
|-----|-----------|-------------|------|
| 1. Release audio chunks early | Audio decode doubling | Up to ~220 MB | Low |
| 2. Cap recording log buffers | Unbounded log strings | Several MB | Very low |
| 3. Cap FFmpeg export stderr | Unbounded FFmpeg logs | Several MB | Very low |
| 4. Clear cursor samples after snapshot | Duplicate cursor data | ~10 MB | Low |
| 5. Null missed canvas refs | Canvas leak in destroy() | ~16-64 MB | Very low |
| 6. Release fallback canvas | Persistent singleton | ~8-33 MB | Very low |
| 7. Lower decode buffer limits | Excessive buffering | ~130 MB at 4K | Low-medium |

**Combined worst-case savings:** ~400+ MB for a 30-minute 4K recording + export on a 4-core machine.

---

## 8. Testing Plan

### Does everything still work?
- [ ] Record 5+ minutes on macOS — video plays correctly, cursor telemetry is intact
- [ ] Record on Windows — same checks
- [ ] Export 1080p with zoom, webcam, annotations, captions — output matches pre-change quality
- [ ] Export as GIF — output is correct
- [ ] Export with speed changes and audio — audio stays in sync
- [ ] Cancel export mid-way — no errors, cleanup runs
- [ ] Record with pause/resume — cursor telemetry is continuous across pauses

### Is memory actually lower?
- [ ] Record for 15 minutes — main process memory stabilizes (no steady climb)
- [ ] Export a 10-minute 1080p video — peak renderer memory is lower than before
- [ ] Export twice in a row — memory drops back to baseline between exports

### Edge cases
- [ ] 30+ minute recording — cursor samples are complete in telemetry file
- [ ] Export with no audio — no crash
- [ ] Export on a machine with 4 GB RAM — completes without OOM

---

## 9. Rollback Plan

Every fix is independent and can be reverted on its own. No data formats, APIs, or file structures are changed.

| Fix | How to revert |
|-----|---------------|
| 1 | Remove the `channelChunks[ch].length = 0` line |
| 2, 3 | Remove the `if (length > max)` trim blocks |
| 4 | Remove the `activeCursorSamples.length = 0` line |
| 5 | Remove the four added null assignments |
| 6 | Remove the `releaseNativeFrameCaptureResources()` call |
| 7 | Restore the original numeric values in the profile objects |
