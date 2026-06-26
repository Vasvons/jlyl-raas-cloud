'use client';

import { useState } from 'react';
import { Tabs } from 'antd';
import ModelsTab from './ModelsTab';
import InstructionsTab from './InstructionsTab';
import KnowledgeTab from './KnowledgeTab';

export default function ConfigPage() {
  const [activeTab, setActiveTab] = useState('models');
  return (
    <div>
      <h2 style={{ marginBottom: 24 }}>配置中心</h2>
      <Tabs activeKey={activeTab} onChange={setActiveTab} items={[
        { key: 'models', label: 'AI 模型配置', children: <ModelsTab /> },
        { key: 'instructions', label: '写作指令库', children: <InstructionsTab /> },
        { key: 'knowledge', label: '企业知识库', children: <KnowledgeTab /> },
      ]} />
    </div>
  );
}
