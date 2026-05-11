import { describe, expect, it } from "vitest";

import {
	getExportBackpressureProfile,
	getPreferredWebCodecsLatencyModes,
	getWebCodecsEncodeQueueLimit,
	getWebCodecsKeyFrameInterval,
} from "./exportTuning";

describe("exportTuning", () => {
	it("prefers realtime latency for fast and balanced exports", () => {
		expect(getPreferredWebCodecsLatencyModes("fast")).toEqual(["realtime", "quality"]);
		expect(getPreferredWebCodecsLatencyModes("balanced")).toEqual(["realtime", "quality"]);
		expect(getPreferredWebCodecsLatencyModes("quality")).toEqual(["quality", "realtime"]);
	});

	it("keeps queue depth bounded by encoding mode", () => {
		expect(getWebCodecsEncodeQueueLimit(60, "fast")).toBe(75);
		expect(getWebCodecsEncodeQueueLimit(60, "balanced")).toBe(120);
		expect(getWebCodecsEncodeQueueLimit(60, "quality")).toBe(144);
		expect(getWebCodecsEncodeQueueLimit(240, "fast")).toBe(96);
		expect(getWebCodecsEncodeQueueLimit(12, "balanced")).toBe(72);
	});

	it("widens keyframe spacing for faster modes", () => {
		expect(getWebCodecsKeyFrameInterval(60, "fast")).toBe(240);
		expect(getWebCodecsKeyFrameInterval(60, "balanced")).toBe(180);
		expect(getWebCodecsKeyFrameInterval(60, "quality")).toBe(150);
	});

	it("uses shallower decode buffers for Breeze than for WebCodecs", () => {
		const webCodecsProfile = getExportBackpressureProfile({
			encodeBackend: "webcodecs",
			width: 1280,
			height: 720,
			frameRate: 60,
			encodingMode: "balanced",
			hardwareConcurrency: 8,
		});
		const breezeProfile = getExportBackpressureProfile({
			encodeBackend: "ffmpeg",
			width: 1280,
			height: 720,
			frameRate: 60,
			encodingMode: "balanced",
			hardwareConcurrency: 8,
		});

		expect(webCodecsProfile.name).toBe("webcodecs-balanced-plus");
		expect(webCodecsProfile.maxDecodeQueue).toBe(8);
		expect(webCodecsProfile.maxPendingFrames).toBe(18);
		expect(breezeProfile.name).toBe("breeze-balanced-plus");
		expect(breezeProfile.maxDecodeQueue).toBe(8);
		expect(breezeProfile.maxPendingFrames).toBe(20);
		expect(breezeProfile.maxInFlightNativeWrites).toBe(4);
	});

	it("falls back to conservative native settings on low-core or very heavy workloads", () => {
		const breezeLowCoreProfile = getExportBackpressureProfile({
			encodeBackend: "ffmpeg",
			width: 1280,
			height: 720,
			frameRate: 60,
			hardwareConcurrency: 4,
		});
		const breezeHeavyProfile = getExportBackpressureProfile({
			encodeBackend: "ffmpeg",
			width: 3840,
			height: 2160,
			frameRate: 60,
			hardwareConcurrency: 12,
		});

		expect(breezeLowCoreProfile.name).toBe("breeze-conservative");
		expect(breezeLowCoreProfile.maxDecodeQueue).toBe(4);
		expect(breezeLowCoreProfile.maxPendingFrames).toBe(8);
		expect(breezeLowCoreProfile.maxInFlightNativeWrites).toBe(1);

		expect(breezeHeavyProfile.name).toBe("breeze-conservative");
		expect(breezeHeavyProfile.maxDecodeQueue).toBe(4);
		expect(breezeHeavyProfile.maxPendingFrames).toBe(8);
	});

	it("scales conservative profile buffers by memory usage setting", () => {
		const base = { encodeBackend: "ffmpeg" as const, width: 1280, height: 720, frameRate: 60, hardwareConcurrency: 4 };

		const low = getExportBackpressureProfile({ ...base, memoryUsage: "low" });
		const balanced = getExportBackpressureProfile({ ...base, memoryUsage: "balanced" });
		const high = getExportBackpressureProfile({ ...base, memoryUsage: "high" });

		expect(low.maxDecodeQueue).toBe(4);
		expect(low.maxPendingFrames).toBe(8);
		expect(low.maxInFlightNativeWrites).toBe(1);

		expect(balanced.maxDecodeQueue).toBe(6);
		expect(balanced.maxPendingFrames).toBe(12);
		expect(balanced.maxInFlightNativeWrites).toBe(1);

		expect(high.maxDecodeQueue).toBe(8);
		expect(high.maxPendingFrames).toBe(16);
		expect(high.maxInFlightNativeWrites).toBe(2);
	});

	it("defaults to low memory usage when not specified", () => {
		const withoutMemory = getExportBackpressureProfile({
			encodeBackend: "ffmpeg", width: 1280, height: 720, frameRate: 60, hardwareConcurrency: 4,
		});
		const withLow = getExportBackpressureProfile({
			encodeBackend: "ffmpeg", width: 1280, height: 720, frameRate: 60, hardwareConcurrency: 4, memoryUsage: "low",
		});

		expect(withoutMemory.maxDecodeQueue).toBe(withLow.maxDecodeQueue);
		expect(withoutMemory.maxPendingFrames).toBe(withLow.maxPendingFrames);
	});

	it("applies memory usage to balanced-plus profiles on high-core systems", () => {
		const base = { encodeBackend: "ffmpeg" as const, width: 1280, height: 720, frameRate: 60, hardwareConcurrency: 8 };

		const low = getExportBackpressureProfile({ ...base, memoryUsage: "low" });
		const high = getExportBackpressureProfile({ ...base, memoryUsage: "high" });

		expect(low.name).toBe("breeze-balanced-plus");
		expect(high.name).toBe("breeze-balanced-plus");
		expect(high.maxPendingFrames).toBeGreaterThan(low.maxPendingFrames);
	});
});
