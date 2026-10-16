import { describe, expect, it } from "vitest";

import { getTerminalThemeColors, THEMES, type ThemeId } from "@/hooks/use-theme";
import { TERMINAL_ANSI_KEYS } from "@/terminal/terminal-ansi-palettes";

const LIGHT_THEME_IDS: readonly ThemeId[] = ["light", "overcast", "solarized-light", "latte", "high-contrast-light"];

const DARK_THEME_IDS: readonly ThemeId[] = [
	"default",
	"graphite",
	"midnight",
	"pitch",
	"solarized-dark",
	"high-contrast-dark",
];

/**
 * Solarized Light's palette intentionally maps its "bright" row onto base greys,
 * so entries like brightGreen sit close to the background. That is the palette's
 * identity, not a defect, so it is exempt from the accent contrast floor.
 */
const CONTRAST_EXEMPT_THEMES: readonly ThemeId[] = ["solarized-light"];

/** Minimum WCAG contrast ratio for palette accents against the background. */
const MIN_ACCENT_CONTRAST = 3;

function parseHex(hex: string): { r: number; g: number; b: number } {
	const normalized = hex.replace("#", "");
	if (!/^[0-9a-fA-F]{6}$/.test(normalized)) {
		throw new Error(`Expected a 6-digit hex color, received "${hex}"`);
	}
	return {
		r: Number.parseInt(normalized.slice(0, 2), 16),
		g: Number.parseInt(normalized.slice(2, 4), 16),
		b: Number.parseInt(normalized.slice(4, 6), 16),
	};
}

/** WCAG 2.1 relative luminance. */
function relativeLuminance(hex: string): number {
	const { r, g, b } = parseHex(hex);
	const channel = (value: number): number => {
		const srgb = value / 255;
		return srgb <= 0.03928 ? srgb / 12.92 : ((srgb + 0.055) / 1.055) ** 2.4;
	};
	return 0.2126 * channel(r) + 0.7152 * channel(g) + 0.0722 * channel(b);
}

/** WCAG 2.1 contrast ratio, always >= 1. */
function contrastRatio(foreground: string, background: string): number {
	const a = relativeLuminance(foreground);
	const b = relativeLuminance(background);
	const lighter = Math.max(a, b);
	const darker = Math.min(a, b);
	return (lighter + 0.05) / (darker + 0.05);
}

describe("terminal ANSI palettes", () => {
	it("lists only themes that are not in the dark group", () => {
		for (const themeId of LIGHT_THEME_IDS) {
			expect(THEMES.find((theme) => theme.id === themeId)?.group).not.toBe("dark");
		}
	});

	it("gives every light theme an explicit ANSI palette", () => {
		for (const themeId of LIGHT_THEME_IDS) {
			expect(getTerminalThemeColors(themeId).ansi).toBeDefined();
		}
	});

	it("leaves dark themes on xterm's built-in palette", () => {
		for (const themeId of DARK_THEME_IDS) {
			expect(getTerminalThemeColors(themeId).ansi).toBeUndefined();
		}
	});

	it("covers all 16 ANSI slots in every palette", () => {
		for (const themeId of LIGHT_THEME_IDS) {
			const ansi = getTerminalThemeColors(themeId).ansi;
			expect(ansi).toBeDefined();
			for (const key of TERMINAL_ANSI_KEYS) {
				expect(ansi?.[key], `${themeId}.${key}`).toMatch(/^#[0-9A-Fa-f]{6}$/);
			}
		}
	});

	it("keeps accent colors legible against each light theme's background", () => {
		for (const themeId of LIGHT_THEME_IDS) {
			if (CONTRAST_EXEMPT_THEMES.includes(themeId)) {
				continue;
			}
			const colors = getTerminalThemeColors(themeId);
			const ansi = colors.ansi;
			expect(ansi).toBeDefined();
			if (!ansi) {
				continue;
			}
			for (const key of TERMINAL_ANSI_KEYS) {
				const ratio = contrastRatio(ansi[key], colors.surfacePrimary);
				expect(ratio, `${themeId}.${key} (${ansi[key]}) contrast ${ratio.toFixed(2)}`).toBeGreaterThanOrEqual(
					MIN_ACCENT_CONTRAST,
				);
			}
		}
	});

	it("keeps the default text color legible against each light theme's background", () => {
		for (const themeId of LIGHT_THEME_IDS) {
			const colors = getTerminalThemeColors(themeId);
			const ratio = contrastRatio(colors.textPrimary, colors.surfacePrimary);
			expect(ratio, `${themeId}.textPrimary contrast ${ratio.toFixed(2)}`).toBeGreaterThanOrEqual(7);
		}
	});

	it("gives light themes dark text on a light background", () => {
		for (const themeId of LIGHT_THEME_IDS) {
			const colors = getTerminalThemeColors(themeId);
			expect(relativeLuminance(colors.surfacePrimary), `${themeId} background should be light`).toBeGreaterThan(0.5);
			expect(relativeLuminance(colors.textPrimary), `${themeId} text should be dark`).toBeLessThan(0.2);
		}
	});

	it("does not reuse the white selection foreground on light themes", () => {
		for (const themeId of LIGHT_THEME_IDS) {
			const colors = getTerminalThemeColors(themeId);
			expect(colors.selectionForeground.toLowerCase(), `${themeId}.selectionForeground`).not.toBe("#ffffff");
		}
	});
});
