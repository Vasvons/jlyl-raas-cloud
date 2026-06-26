'use client';

import React from 'react';
import { usePathname, useRouter } from 'next/navigation';
import {
  UserOutlined,
  KeyOutlined,
  LinkOutlined,
  ScheduleOutlined,
  DashboardOutlined,
  FileTextOutlined,
} from '@ant-design/icons';
import './console.css';

const MENU_ITEMS = [
  { key: '/console/users', label: '用户管理', icon: <UserOutlined /> },
  { key: '/console/keywords', label: '关键词配置', icon: <KeyOutlined /> },
  { key: '/console/keywordsmaintain', label: '收录结果', icon: <LinkOutlined /> },
  { key: '/console/task', label: '收录查询', icon: <ScheduleOutlined /> },
  { key: '/console/monitor', label: '数据监测', icon: <DashboardOutlined /> },
  { key: '/console/content', label: '内容中枢', icon: <FileTextOutlined /> },
];

export default function ConsoleLayout({ children }: { children: React.ReactNode }) {
  const pathname = usePathname();
  const router = useRouter();

  return (
    <div style={{ display: 'flex', minHeight: '100vh' }}>
      {/* 侧边栏 */}
      <div
        style={{
          width: 210,
          background: '#fff',
          color: '#1f1f1f',
          padding: '20px 0',
          flexShrink: 0,
          borderRight: '1px solid #e8e8e8',
          display: 'flex',
          flexDirection: 'column',
        }}
      >
        {/* Logo 区 */}
        <div style={{ padding: '0 20px 24px 20px', borderBottom: '1px solid #f0f0f0', marginBottom: 12 }}>
          <div style={{ fontSize: 22, fontWeight: 700, letterSpacing: 2, color: '#1677ff', lineHeight: 1.2 }}>
            JLYL
          </div>
          <div style={{ fontSize: 12, color: '#999', marginTop: 4 }}>管理后台</div>
        </div>
        {/* 菜单项 */}
        {MENU_ITEMS.map((item) => {
          const active = pathname === item.key || pathname.startsWith(item.key + '/');
          return (
            <div
              key={item.key}
              onClick={() => router.push(item.key)}
              style={{
                padding: '12px 20px',
                cursor: 'pointer',
                background: active ? '#e6f4ff' : 'transparent',
                color: active ? '#1677ff' : '#1f1f1f',
                fontSize: 14,
                fontWeight: active ? 500 : 400,
                borderLeft: active ? '3px solid #1677ff' : '3px solid transparent',
                transition: 'all 0.2s',
                display: 'flex',
                alignItems: 'center',
                gap: 10,
                margin: '2px 0',
              }}
              onMouseEnter={(e) => { if (!active) e.currentTarget.style.background = '#f0f5ff'; }}
              onMouseLeave={(e) => { if (!active) e.currentTarget.style.background = 'transparent'; }}
            >
              <span style={{ fontSize: 16, display: 'flex', alignItems: 'center' }}>{item.icon}</span>
              <span>{item.label}</span>
            </div>
          );
        })}
      </div>
      {/* 内容区 */}
      <div style={{ flex: 1, padding: 24, background: '#f0f2f5', overflow: 'auto' }}>
        <div
          style={{
            background: '#fff',
            padding: 24,
            minHeight: 'calc(100vh - 48px)',
            borderRadius: 8,
            boxShadow: '0 1px 3px rgba(0, 0, 0, 0.08)',
          }}
        >
          {children}
        </div>
      </div>
    </div>
  );
}
