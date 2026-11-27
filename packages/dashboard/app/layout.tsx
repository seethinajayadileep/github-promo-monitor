import type { Metadata } from 'next';
import './globals.css';

export const metadata: Metadata = {
  title: 'Public Promo Code Monitor',
  description: 'GitHub public SaaS, AI, and developer-tool promo-code monitoring dashboard'
};

export default function RootLayout({ children }: { children: React.ReactNode }) {
  return (
    <html lang="en">
      <body>{children}</body>
    </html>
  );
}
