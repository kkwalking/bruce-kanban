import { describe, expect, it } from "vitest";

import { getTerminalThemeColors } from "@/hooks/use-theme";
import { createKanbanTerminalOptions } from "@/terminal/terminal-options";

function buildOptions(themeId: Parameters<typeof getTerminalThemeColors>[0]) {
	return createKanbanTerminalOptions({
		cursorColor: "#abcdef",
		isMacPlatform: true,
		terminalBackgroundColor: "#101112",
		themeColors: getTerminalThemeColors(themeId),
	});
}

describe("createKanbanTerminalOptions", () => {
	it("enables richer terminal capability reporting", () => {
		const options = buildOptions("default");

		expect(options.allowProposedApi).toBe(true);
		expect(options.cursorBlink).toBe(false);
		expect(options.cursorInactiveStyle).toBe("outline");
		expect(options.cursorStyle).toBe("block");
		expect(options.scrollback).toBe(10_000);
		expect(options.macOptionIsMeta).toBe(true);
		expect(options.windowOptions).toEqual({
			getCellSizePixels: true,
			getWinSizeChars: true,
			getWinSizePixels: true,
		});
		expect(options.theme?.background).toBe("#101112");
		expect(options.theme?.cursor).toBe("#abcdef");
	});

	it("keeps Menlo reachable so macOS always has a monospace fallback", () => {
		const options = buildOptions("default");
		expect(options.fontFamily).toContain("Menlo");
	});

	it("forwards the light theme ANSI palette to xterm", () => {
		const options = buildOptions("light");
		const palette = getTerminalThemeColors("light").ansi;

		expect(palette).toBeDefined();
		expect(options.theme?.red).toBe(palette?.red);
		expect(options.theme?.brightWhite).toBe(palette?.brightWhite);
	});

	it("omits ANSI overrides for dark themes so xterm defaults apply", () => {
		const options = buildOptions("default");

		expect(options.theme?.red).toBeUndefined();
		expect(options.theme?.brightWhite).toBeUndefined();
	});

	it("never lets an ANSI palette override the structural colors", () => {
		const options = buildOptions("light");

		expect(options.theme?.background).toBe("#101112");
		expect(options.theme?.foreground).toBe(getTerminalThemeColors("light").textPrimary);
	});
});
