import "./globals.css";
import type { Metadata, Viewport } from "next";

export const metadata: Metadata = {
  title: "Oversight",
  description: "Real-time camera surveillance with person detection",
  manifest: "/manifest.webmanifest",
  appleWebApp: {
    capable: true,
    title: "Oversight",
  },
};

export const viewport: Viewport = {
  themeColor: "#0d1117",
};

export default function RootLayout({
  children,
}: {
  children: React.ReactNode;
}) {
  return (
    <html lang="en">
      <body>{children}</body>
    </html>
  );
}
