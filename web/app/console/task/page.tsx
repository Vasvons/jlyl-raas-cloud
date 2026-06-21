'use client';

import React, { useState } from 'react';
import { Tabs } from 'antd';
import GeneratedDataTask from './GeneratedDataTask';
import RealCollectTask from './RealCollectTask';

export default function TaskPage() {
  const [activeTab, setActiveTab] = useState('generated');

  return (
    <div style={{ padding: 24 }}>
      <Tabs
        activeKey={activeTab}
        onChange={setActiveTab}
        items={[
          {
            key: 'generated',
            label: '数据生成任务',
            children: <GeneratedDataTask />,
          },
          {
            key: 'real',
            label: '真实查询任务',
            children: <RealCollectTask />,
          },
        ]}
      />
    </div>
  );
}
