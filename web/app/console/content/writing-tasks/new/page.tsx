'use client';

import { useEffect, useState } from 'react';
import { Card, Steps, Button, Form, Select, Input, Table, Tag, message, Spin, Space, Statistic } from 'antd';
import { useRouter } from 'next/navigation';
import api from '@/lib/api';

export default function NewWritingTaskPage() {
  const router = useRouter();
  const [current, setCurrent] = useState(0);
  const [loading, setLoading] = useState(false);
  const [instructions, setInstructions] = useState<any[]>([]);
  const [knowledge, setKnowledge] = useState<any[]>([]);
  const [models, setModels] = useState<any[]>([]);
  const [keywords, setKeywords] = useState<any[]>([]);
  const [selectedKeywordIds, setSelectedKeywordIds] = useState<number[]>([]);
  const [form] = Form.useForm();

  useEffect(() => {
    Promise.all([
      api.get('/content/instructions'),
      api.get('/content/knowledge'),
      api.get('/content/models'),
      api.get('/dstillateKeyword/getAllDstillateKeyword'), // 复用现有蒸馏词库API
    ]).then(([insRes, knRes, modRes, kwRes]) => {
      if (insRes.data?.code === 200) setInstructions(insRes.data.data);
      if (knRes.data?.code === 200) setKnowledge(knRes.data.data);
      if (modRes.data?.code === 200) setModels(modRes.data.data.filter((m: any) => m.is_active));
      if (kwRes.data?.code === 200) setKeywords(kwRes.data.data || []);
    });
  }, []);

  const steps = [
    { title: '选关键词', content: null },
    { title: '选指令', content: null },
    { title: '选知识库', content: null },
    { title: '选模型', content: null },
    { title: '确认', content: null },
  ];

  const handleCreate = async () => {
    const values = form.getFieldsValue();
    if (selectedKeywordIds.length === 0) { message.error('请选择关键词'); return; }
    if (!values.instruction_id) { message.error('请选择指令'); return; }
    if (!values.knowledge_id) { message.error('请选择知识库'); return; }
    if (!values.model_config_id) { message.error('请选择模型'); return; }
    setLoading(true);
    try {
      const res = await api.post('/content/writing-tasks', {
        task_name: values.task_name,
        keyword_ids: selectedKeywordIds,
        instruction_id: values.instruction_id,
        knowledge_id: values.knowledge_id,
        model_config_id: values.model_config_id,
      });
      if (res.data?.code === 200) {
        message.success('任务已创建，开始生成');
        router.push('/console/content/writing-tasks');
      }
    } finally {
      setLoading(false);
    }
  };

  const keywordColumns = [
    { title: '关键词', dataIndex: 'value' },
    { title: '类型', dataIndex: 'keyword_type', render: (t: number) => t === 1 ? <Tag color="blue">品牌</Tag> : <Tag>蒸馏</Tag> },
  ];

  return (
    <div>
      <h2 style={{ marginBottom: 24 }}>新建写作任务</h2>
      <Steps current={current} items={steps.map(s => ({ title: s.title }))} style={{ marginBottom: 24 }} />
      <Card>
        {current === 0 && (
          <div>
            <p>已选 {selectedKeywordIds.length} 个关键词</p>
            <Table columns={keywordColumns} dataSource={keywords} rowKey="id" size="small"
              rowSelection={{ type: 'checkbox', selectedRowKeys: selectedKeywordIds,
                onChange: (keys) => setSelectedKeywordIds(keys as number[]) }}
              pagination={{ pageSize: 10 }} />
          </div>
        )}
        {current === 1 && (
          <Form form={form} layout="vertical">
            <Form.Item name="task_name" label="任务名称"><Input placeholder="如：财税服务-决策层-批量生成" /></Form.Item>
            <Form.Item name="instruction_id" label="写作指令" rules={[{ required: true }]}>
              <Select options={instructions.map(i => ({ value: i.id, label: `${i.name}（${i.category}）` }))} />
            </Form.Item>
          </Form>
        )}
        {current === 2 && (
          <Form form={form} layout="vertical">
            <Form.Item name="knowledge_id" label="企业知识库" rules={[{ required: true }]}>
              <Select options={knowledge.map(k => ({ value: k.id, label: `${k.company_full_name}（${k.city || ''}）` }))} />
            </Form.Item>
          </Form>
        )}
        {current === 3 && (
          <Form form={form} layout="vertical">
            <Form.Item name="model_config_id" label="AI模型" rules={[{ required: true }]}>
              <Select options={models.map(m => ({
                value: m.id,
                label: `${m.platform} - ${m.model_name}${m.is_shared ? '（共享KEY）' : '（自有）'}`,
              }))} />
            </Form.Item>
          </Form>
        )}
        {current === 4 && (
          <div>
            <Space direction="vertical" size="large">
              <Statistic title="将生成文章数" value={selectedKeywordIds.length} suffix="篇" />
              <p>预计消耗 {selectedKeywordIds.length} 次 API 调用</p>
            </Space>
          </div>
        )}
      </Card>
      <Space style={{ marginTop: 16 }}>
        {current > 0 && <Button onClick={() => setCurrent(current - 1)}>上一步</Button>}
        {current < 4 && <Button type="primary" onClick={() => setCurrent(current + 1)}>下一步</Button>}
        {current === 4 && <Button type="primary" loading={loading} onClick={handleCreate}>确认创建</Button>}
      </Space>
    </div>
  );
}
