import type { Metadata } from "next";
import { Ubuntu } from "next/font/google";
import "./globals.css";

/**
 * Ubuntu for UI text. Not a variable font, so the weights the interface
 * actually uses are requested explicitly — anything omitted here would be
 * synthesised by the browser and look smeared.
 */
const sans = Ubuntu({
  variable: "--font-sans-ui",
  weight: ["300", "400", "500", "700"],
  subsets: ["latin"],
  display: "swap",
});

/*
 * Numbers use Ubuntu too — one family, everywhere.
 *
 * Safe to do because Ubuntu's digits are already uniform width: measured at
 * 40px, every glyph 0-9 is 22.5625px with or without `tabular-nums`. So prices
 * and pips still line up in columns and do not jitter as they change, which is
 * the only reason a separate monospaced face was here.
 *
 * `--font-mono-ui` is aliased to this one in globals.css, so `font-mono`
 * classes and the canvas label lookup keep working.
 */

export const metadata: Metadata = {
  title: "XAUUSDm — Chart",
  description: "Candlestick terminal for XAUUSDm, MetaTrader 5 server time.",
};

export default function RootLayout({ children }: LayoutProps<"/">) {
  return (
    <html
      lang="en"
      className={`${sans.variable} h-full antialiased`}
    >
      <body className="h-full overflow-hidden bg-term-bg text-term-text">
        {children}
      </body>
    </html>
  );
}
