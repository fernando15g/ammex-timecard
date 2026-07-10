import type { Metadata, Viewport } from "next";
import "./globals.css";
export const metadata: Metadata = {
  title: "Ammex Timecard",
  description: "Daily crew timecard",
  manifest: "/manifest.json",
  icons: {
    icon: [
      { url: "/pwa/icon-32x32.png", sizes: "32x32", type: "image/png" },
      { url: "/pwa/icon-192x192.png", sizes: "192x192", type: "image/png" },
    ],
    apple: [
      { url: "/pwa/icon-192x192.png", sizes: "192x192", type: "image/png" },
    ],
  },
};
export const viewport: Viewport = {
  width: "device-width",
  initialScale: 1,
  maximumScale: 1,
  themeColor: "#1c2127",
};
export default function RootLayout({
  children,
}: {
  children: React.ReactNode;
}) {
  return (
    <html lang="es">
      <body>{children}</body>
    </html>
  );
}
