import "./globals.css";
import type { Metadata } from "next";

export const metadata: Metadata = {
  title: "VMS Dashboard",
  description: "Real-time camera surveillance with person detection",
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
