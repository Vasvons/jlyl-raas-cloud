import type { Metadata } from 'next';
import 'antd/dist/reset.css';

export const metadata: Metadata = {
  title: '聚量引力 RaaS - GEO报告',
  description: '聚量引力RaaS平台GEO报告系统',
};

export default function RootLayout({
  children,
}: {
  children: React.ReactNode;
}) {
  return (
    <html lang="zh-CN">
      <body>{children}</body>
    </html>
  );
}
