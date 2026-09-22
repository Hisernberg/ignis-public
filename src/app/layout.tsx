import type { Metadata } from "next";
import { Geist, Geist_Mono } from "next/font/google";
import "./globals.css";
import { Toaster } from "@/components/ui/toaster";

const geistSans = Geist({
  variable: "--font-geist-sans",
  subsets: ["latin"],
});

const geistMono = Geist_Mono({
  variable: "--font-geist-mono",
  subsets: ["latin"],
});

export const metadata: Metadata = {
  metadataBase: new URL("https://ignis-spaceapps2026.vercel.app"),
  title: "IGNIS — Earth's Burning Activity Calendar | NASA Space Apps 2026",
  description:
    "A 26-year harmonized global burning-activity calendar and early-warning dashboard built on NASA FIRMS, GIBS WMTS, EONET and Hugging Face models.",
  keywords: ["NASA", "Space Apps", "FIRMS", "MODIS", "VIIRS", "GIBS", "wildfire", "early warning", "IGNIS"],
  authors: [{ name: "Team IGNIS" }],
  icons: {
    icon: [
      { url: "/favicon.ico", sizes: "48x48" },
      { url: "/icon-192.png", sizes: "192x192", type: "image/png" },
      { url: "/icon-512.png", sizes: "512x512", type: "image/png" },
    ],
    apple: "/apple-touch-icon.png",
  },
  openGraph: {
    title: "IGNIS — Earth's Burning Activity Calendar",
    description:
      "Harmonizing 26 years of MODIS + VIIRS hot spots into one burning-activity calendar with live early warning.",
    siteName: "IGNIS",
    type: "website",
    images: [
      {
        url: "/og-image.png",
        width: 1200,
        height: 630,
        alt: "IGNIS — Earth's Burning Activity Calendar",
      },
    ],
  },
  twitter: {
    card: "summary_large_image",
    title: "IGNIS — Earth's Burning Activity Calendar",
    description: "26 years of MODIS + VIIRS hot spots, harmonized into one calendar with live early warning.",
    images: ["/og-image.png"],
  },
};

export default function RootLayout({
  children,
}: Readonly<{
  children: React.ReactNode;
}>) {
  return (
    <html lang="en" suppressHydrationWarning>
      <body
        className={`${geistSans.variable} ${geistMono.variable} antialiased bg-background text-foreground`}
      >
        {children}
        <Toaster />
      </body>
    </html>
  );
}
