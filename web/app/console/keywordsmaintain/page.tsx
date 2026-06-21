'use client';

import React, { useState } from 'react';
import { Tabs } from 'antd';
import GeneratedDataMaintain from './GeneratedDataMaintain';
import RealCollectResults from './RealCollectResults';

export default function KeywordsMaintainPage() {
  const [activeTab, setActiveTab] = useState('generated');

  return (
    <div style={{ padding: 24 }}>
      <Tabs
        activeKey={activeTab}
        onChange={setActiveTab}
        items={[
          {
            key: 'generated',
            label: '任务生成数据',
            children: <GeneratedDataMaintain />,
          },
          {
            key: 'real',
            label: '真实查询结果',
            children: <RealCollectResults />,
          },
        ]}
      />
    </div>
  );
}
