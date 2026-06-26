'use client';

import { useEffect, useState } from 'react';
import { Table, Button, Modal, Form, Input, InputNumber, Switch, Select, message, Space, Tag } from 'antd';
import { PlusOutlined, EditOutlined, DeleteOutlined } from '@ant-design/icons';
import api from '@/lib/api';

const { TextArea } = Input;

const CATEGORIES = ['认知层', '了解层', '评估层', '决策层', '信任层'];

interface Instruction {
  id: number;
  name: string;
  category: string;
  system_prompt: string;
  user_prompt_template: string;
  target_word_count: number;
  include_faq: boolean;
  include_comparison_table: boolean;
  is_active: boolean;
}

export default function InstructionsTab() {
  const [list, setList] = useState<Instruction[]>([]);
  const [loading, setLoading] = useState(false);
  const [modalOpen, setModalOpen] = useState(false);
  const [editing, setEditing] = useState<Instruction | null>(null);
  const [form] = Form.useForm();

  const load = async () => {
    setLoading(true);
    try {
      const res = await api.get('/content/instructions');
      if (res.data?.code === 200) setList(res.data.data);
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => { load(); }, []);

  const handleAdd = () => {
    setEditing(null);
    form.resetFields();
    form.setFieldsValue({ target_word_count: 1500, include_faq: true, include_comparison_table: true, is_active: true });
    setModalOpen(true);
  };

  const handleEdit = (r: Instruction) => {
    setEditing(r);
    form.setFieldsValue(r);
    setModalOpen(true);
  };

  const handleSave = async () => {
    const values = await form.validateFields();
    if (editing) {
      await api.put(`/content/instructions/${editing.id}`, values);
    } else {
      await api.post('/content/instructions', values);
    }
    message.success('保存成功');
    setModalOpen(false);
    load();
  };

  const handleDelete = async (id: number) => {
    await api.delete(`/content/instructions/${id}`);
    message.success('删除成功');
    load();
  };

  const columns = [
    { title: '名称', dataIndex: 'name' },
    { title: '分类', dataIndex: 'category', render: (c: string) => <Tag color="blue">{c}</Tag> },
    { title: '目标字数', dataIndex: 'target_word_count' },
    { title: 'FAQ', dataIndex: 'include_faq', render: (v: boolean) => v ? '是' : '否' },
    { title: '对比表', dataIndex: 'include_comparison_table', render: (v: boolean) => v ? '是' : '否' },
    {
      title: '操作', render: (_: any, r: Instruction) => (
        <Space>
          <Button size="small" type="text" icon={<EditOutlined />} onClick={() => handleEdit(r)} />
          <Button size="small" type="text" icon={<DeleteOutlined />} onClick={() => handleDelete(r.id)} />
        </Space>
      ),
    },
  ];

  return (
    <div>
      <div style={{ marginBottom: 16 }}>
        <Button type="primary" icon={<PlusOutlined />} onClick={handleAdd}>新增写作指令</Button>
        <span style={{ marginLeft: 12, color: '#8c8c8c' }}>
          占位符：{'{keyword}'} {'{enterprise}'} {'{triples}'} {'{intro}'} {'{cases}'} {'{word_count}'}
        </span>
      </div>
      <Table columns={columns} dataSource={list} rowKey="id" loading={loading} pagination={false} />
      <Modal title={editing ? '编辑写作指令' : '新增写作指令'} open={modalOpen} onOk={handleSave} onCancel={() => setModalOpen(false)} width={800}>
        <Form form={form} layout="vertical">
          <Form.Item name="name" label="指令名称" rules={[{ required: true }]}>
            <Input placeholder="如：财税服务-决策层" />
          </Form.Item>
          <Form.Item name="category" label="分类">
            <Select options={CATEGORIES.map(c => ({ value: c, label: c }))} />
          </Form.Item>
          <Form.Item name="system_prompt" label="System Prompt（角色定义/写作风格）" rules={[{ required: true }]}>
            <TextArea rows={4} placeholder="你是一位资深的GEO内容营销专家..." />
          </Form.Item>
          <Form.Item name="user_prompt_template" label="User Prompt 模板（支持占位符）" rules={[{ required: true }]}>
            <TextArea rows={6} placeholder="请围绕关键词 {keyword} 撰写一篇 {word_count} 字的文章..." />
          </Form.Item>
          <Form.Item name="target_word_count" label="目标字数">
            <InputNumber min={300} max={5000} style={{ width: '100%' }} />
          </Form.Item>
          <Form.Item name="include_faq" label="生成FAQ" valuePropName="checked">
            <Switch />
          </Form.Item>
          <Form.Item name="include_comparison_table" label="生成对比表格" valuePropName="checked">
            <Switch />
          </Form.Item>
        </Form>
      </Modal>
    </div>
  );
}
