import type { Metadata } from "next";
import { Geist, Geist_Mono } from "next/font/google";
import "./globals.css";

const geistSans = Geist({
  variable: "--font-geist-sans",
  subsets: ["latin"],
});

const geistMono = Geist_Mono({
  variable: "--font-geist-mono",
  subsets: ["latin"],
});

const siteOrigin = process.env.SITE_ORIGIN ?? "http://localhost:3000";

export const metadata: Metadata = {
  metadataBase: new URL(siteOrigin),
  title: "DirectDrop — Public video download links",
  description:
    "Upload a video and get a permanent public direct-download link for AI analysis.",
  openGraph: {
    title: "DirectDrop — Public video download links",
    description: "Upload once. Share directly. No login, preview page, or expiring URL.",
    type: "website",
    images: [{ url: "/og.png", width: 1731, height: 909, alt: "DirectDrop — Upload once. Share directly." }],
  },
  twitter: {
    card: "summary_large_image",
    title: "DirectDrop — Public video download links",
    description: "Upload once. Share directly. No login, preview page, or expiring URL.",
    images: ["/og.png"],
  },
  icons: {
    icon: "/favicon.svg",
    shortcut: "/favicon.svg",
  },
};

export default function RootLayout({
  children,
}: Readonly<{
  children: React.ReactNode;
}>) {
  return (
    <html lang="en">
      <body className={`${geistSans.variable} ${geistMono.variable}`}>
        {children}
      </body>
    </html>
  );
}
