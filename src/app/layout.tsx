import type { Metadata } from "next";
import { Newsreader, DM_Sans } from "next/font/google";
import { headers } from "next/headers";
import "./globals.css";
import { Sidebar } from "@/components/sidebar";
import { HelpBot } from "@/components/help-bot";
import { ToasterProvider } from "@/components/ui/toaster";

const newsreader = Newsreader({
  variable: "--font-newsreader",
  subsets: ["latin"],
  weight: ["400", "500", "600", "700"],
  display: "swap",
});

const dmSans = DM_Sans({
  variable: "--font-dm-sans",
  subsets: ["latin"],
  weight: ["400", "500", "600"],
  display: "swap",
});

export const metadata: Metadata = {
  title: "Mail — Email Dashboard",
  description: "Self-hosted email platform powered by Resend",
};

export default async function RootLayout({
  children,
}: Readonly<{ children: React.ReactNode }>) {
  const h = await headers();
  const pathname = h.get("x-pathname") || h.get("x-invoke-path") || "";
  const isAuthRoute = pathname.startsWith("/login");
  return (
    <html lang="en" className={`${newsreader.variable} ${dmSans.variable} h-full antialiased`}>
      <body className="h-full">
        <ToasterProvider>
          {isAuthRoute ? (
            children
          ) : (
            <>
              <div className="app-layout">
                <Sidebar />
                <div className="app-content">{children}</div>
              </div>
              <HelpBot />
            </>
          )}
        </ToasterProvider>
      </body>
    </html>
  );
}
