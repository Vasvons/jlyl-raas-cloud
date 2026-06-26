'use client';

import { ReactNode } from 'react';
import Link from 'next/link';
import { usePathname } from 'next/navigation';
import { FileTextOutlined, ReadOutlined, EditOutlined, RocketOutlined, SettingOutlined } from '@ant-design/icons';

const MENU_ITEMS = [
  { key: '/console/content', label: '仪表盘', icon: <FileTextOutlined /> },
  { key: '/console/content/articles', label: '文章管理', icon: <EditOutlined /> },
  { key: '/console/content/writing-tasks', label: '写作任务', icon: <RocketOutlined /> },
  { key: '/console/content/config', label: '配置中心', icon: <SettingOutlined /> },
];

export default function ContentLayout({ children }: { children: ReactNode }) {
  const pathname = usePathname();
  return (
    <div style={{ display: 'flex', minHeight: 'calc(100vh - 64px)' }}>
      <div style={{ width: 200, borderRight: '1px solid #f0f0f0', padding: '16px 0', background: '#fafafa' }}>
        {MENU_ITEMS.map(item => {
          const active = pathname === item.key || (item.key !== '/console/content' && pathname.startsWith(item.key));
          return (
            <Link key={item.key} href={item.key}
              style={{
                display: 'flex', alignItems: 'center', gap: 8,
                padding: '10px 24px', color: active ? '#1677ff' : '#595959',
                background: active ? '#e6f4ff' : 'transparent',
                borderRight: active ? '3px solid #1677ff' : '3px solid transparent',
                textDecoration: 'none', fontSize: 14,
              }}>
              {item.icon}
              {item.label}
            </Link>
          );
        })}
      </div>
      <div style={{ flex: 1, padding: 24, overflow: 'auto' }}>
        {children}
      </div>
    </div>
  );
}
