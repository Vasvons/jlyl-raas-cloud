'use client';

import React from 'react';
import { usePathname, useRouter } from 'next/navigation';

const MENU_ITEMS = [
  { key: '/console/users', label: '用户管理' },
  { key: '/console/keywords', label: '关键词配置' },
  { key: '/console/keywordsmaintain', label: '收录跳转维护' },
  { key: '/console/task', label: '数据生成任务' },
  { key: '/console/monitor', label: '数据监测' },
];

export default function ConsoleLayout({ children }: { children: React.ReactNode }) {
  const pathname = usePathname();
  const router = useRouter();

  return (
    <div style={{ display: 'flex', minHeight: '100vh' }}>
      {/* 侧边栏 - 浅色主题 */}
      <div style={{ width: 200, background: '#fff', color: '#333', padding: '16px 0', flexShrink: 0, borderRight: '1px solid #f0f0f0' }}>
        <div style={{ padding: '0 16px 24px 16px', fontSize: 20, fontWeight: 'bold', letterSpacing: 2, marginBottom: 8, color: '#1890ff' }}>
          JLYL
        </div>
        {MENU_ITEMS.map((item) => {
          // 精确匹配：pathname === item.key 或 pathname 以 item.key + '/' 开头
          // 避免 /console/keywordsmaintain 误匹配 /console/keywords
          const active = pathname === item.key || pathname.startsWith(item.key + '/');
          return (
            <div
              key={item.key}
              onClick={() => router.push(item.key)}
              style={{
                padding: '12px 16px',
                cursor: 'pointer',
                background: active ? '#e6f7ff' : 'transparent',
                color: active ? '#1890ff' : '#333',
                fontSize: 14,
                borderLeft: active ? '3px solid #1890ff' : '3px solid transparent',
                transition: 'all 0.2s',
              }}
              onMouseEnter={(e) => { if (!active) e.currentTarget.style.background = '#fafafa'; }}
              onMouseLeave={(e) => { if (!active) e.currentTarget.style.background = 'transparent'; }}
            >
              {item.label}
            </div>
          );
        })}
      </div>
      {/* 内容区 */}
      <div style={{ flex: 1, padding: 24, background: '#f5f5f5', overflow: 'auto' }}>
        <div style={{ background: '#fff', padding: 24, minHeight: 'calc(100vh - 48px)', borderRadius: 4 }}>
          {children}
        </div>
      </div>
    </div>
  );
}
