'use client';

import { useEffect, useState } from 'react';
import { Table, Button, Modal, Form, Input, InputNumber, Switch, message, Tag, Space, Tooltip } from 'antd';
import { PlusOutlined, EditOutlined, DeleteOutlined, ApiOutlined } from '@ant-design/icons';
import api from '@/lib/api';

interface ModelConfig {
  id: number;
  user_id: number | null;
  platform: string;
  model_name: string;
  base_url: string;
  max_tokens: number;
  temperature: number;
  is_active: boolean;
  is_shared: boolean;
  daily_quota: number | null;
  used_today: number;
  api_key_masked?: string;
}

const PLATFORM_NAMES: Record<string, string> = {
  deepseek: 'DeepSeek', doubao: '豆包', hunyuan: '腾讯混元',
  qianwen: '通义千问', wenxin: '文心一言', kimi: 'Kimi', zhipu: '智谱AI',
};

export default function ModelsTab() {
  const [list, setList] = useState<ModelConfig[]>([]);
  const [loading, setLoading] = useState(false);
  const [modalOpen, setModalOpen] = useState(false);
  const [editing, setEditing] = useState<ModelConfig | null>(null);
  const [form] = Form.useForm();

  const load = async () => {
    setLoading(true);
    try {
      const res = await api.get('/content/models');
      if (res.data?.code === 200) setList(res.data.data);
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => { load(); }, []);

  const handleAdd = () => {
    setEditing(null);
    form.resetFields();
    form.setFieldsValue({ max_tokens: 4096, temperature: 0.7, is_active: true });
    setModalOpen(true);
  };

  const handleEdit = (record: ModelConfig) => {
    setEditing(record);
    form.setFieldsValue({ ...record, api_key: '' });
    setModalOpen(true);
  };

  const handleSave = async () => {
    const values = await form.validateFields();
    if (editing) {
      const updateData: any = { ...values };
      if (!values.api_key) delete updateData.api_key;
      await api.put(`/content/models/${editing.id}`, updateData);
    } else {
      await api.post('/content/models', values);
    }
    message.success('保存成功');
    setModalOpen(false);
    load();
  };

  const handleDelete = async (id: number) => {
    await api.delete(`/content/models/${id}`);
    message.success('删除成功');
    load();
  };

  const handleTest = async (id: number) => {
    const res = await api.post(`/content/models/${id}/test`);
    if (res.data?.data?.success) {
      message.success(`连接成功：${res.data.data.message}`);
    } else {
      message.error(`连接失败：${res.data?.data?.message || '未知错误'}`);
    }
  };

  const columns = [
    { title: '平台', dataIndex: 'platform', render: (p: string) => PLATFORM_NAMES[p] || p },
    { title: '模型名', dataIndex: 'model_name' },
    { title: '类型', dataIndex: 'is_shared', render: (s: boolean) => s ? <Tag color="blue">共享</Tag> : <Tag color="green">自有</Tag> },
    { title: 'API-KEY', dataIndex: 'api_key_masked', render: (v: string) => v || '未配置' },
    { title: '今日用量', render: (_: any, r: ModelConfig) => r.daily_quota ? `${r.used_today}/${r.daily_quota}` : r.used_today },
    { title: '状态', dataIndex: 'is_active', render: (a: boolean) => a ? <Tag color="green">启用</Tag> : <Tag>禁用</Tag> },
    {
      title: '操作', render: (_: any, r: ModelConfig) => (
        <Space>
          {!r.is_shared && <>
            <Tooltip title="编辑"><Button size="small" type="text" icon={<EditOutlined />} onClick={() => handleEdit(r)} /></Tooltip>
            <Tooltip title="删除"><Button size="small" type="text" icon={<DeleteOutlined />} onClick={() => handleDelete(r.id)} /></Tooltip>
          </>}
          <Tooltip title="测试连接"><Button size="small" type="text" icon={<ApiOutlined />} onClick={() => handleTest(r.id)} /></Tooltip>
        </Space>
      ),
    },
  ];

  return (
    <div>
      <div style={{ marginBottom: 16 }}>
        <Button type="primary" icon={<PlusOutlined />} onClick={handleAdd}>新增模型配置</Button>
        <span style={{ marginLeft: 12, color: '#8c8c8c' }}>未填写时使用平台共享KEY（每日额度有限）</span>
      </div>
      <Table columns={columns} dataSource={list} rowKey="id" loading={loading} pagination={false} />
      <Modal title={editing ? '编辑模型配置' : '新增模型配置'} open={modalOpen} onOk={handleSave} onCancel={() => setModalOpen(false)} width={600}>
        <Form form={form} layout="vertical">
          <Form.Item name="platform" label="平台" rules={[{ required: true }]}>
            <Input disabled={!!editing} placeholder="如 deepseek" />
          </Form.Item>
          <Form.Item name="model_name" label="模型名" rules={[{ required: true }]}>
            <Input placeholder="如 deepseek-chat" />
          </Form.Item>
          <Form.Item name="api_key" label="API-KEY" extra={editing ? '留空表示不修改' : ''}>
            <Input.Password placeholder="sk-..." />
          </Form.Item>
          <Form.Item name="base_url" label="Base URL" rules={[{ required: true }]}>
            <Input placeholder="https://api.deepseek.com/v1/chat/completions" />
          </Form.Item>
          <Form.Item name="max_tokens" label="Max Tokens">
            <InputNumber min={256} max={32768} style={{ width: '100%' }} />
          </Form.Item>
          <Form.Item name="temperature" label="Temperature">
            <InputNumber min={0} max={2} step={0.1} style={{ width: '100%' }} />
          </Form.Item>
          <Form.Item name="is_active" label="启用" valuePropName="checked">
            <Switch />
          </Form.Item>
        </Form>
      </Modal>
    </div>
  );
}
