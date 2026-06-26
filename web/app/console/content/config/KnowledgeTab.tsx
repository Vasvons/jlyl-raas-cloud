'use client';

import { useEffect, useState } from 'react';
import { Table, Button, Modal, Form, Input, InputNumber, message, Space, Card, Empty, Tag } from 'antd';
import { PlusOutlined, EditOutlined, DeleteOutlined, PlusCircleOutlined, MinusCircleOutlined } from '@ant-design/icons';
import api from '@/lib/api';

const { TextArea } = Input;

interface Triple { subject: string; relation: string; object: string; }
interface Knowledge {
  id: number;
  company_full_name: string;
  company_short_name?: string;
  city?: string;
  address?: string;
  industry?: string;
  founded_year?: number;
  business_scope?: string;
  entity_triples?: Triple[];
  intro_text?: string;
  cases_text?: string;
}

export default function KnowledgeTab() {
  const [list, setList] = useState<Knowledge[]>([]);
  const [loading, setLoading] = useState(false);
  const [modalOpen, setModalOpen] = useState(false);
  const [editing, setEditing] = useState<Knowledge | null>(null);
  const [form] = Form.useForm();

  const load = async () => {
    setLoading(true);
    try {
      const res = await api.get('/content/knowledge');
      if (res.data?.code === 200) setList(res.data.data);
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => { load(); }, []);

  const handleAdd = () => {
    setEditing(null);
    form.resetFields();
    form.setFieldsValue({ entity_triples: [] });
    setModalOpen(true);
  };

  const handleEdit = (r: Knowledge) => {
    setEditing(r);
    form.setFieldsValue({ ...r, entity_triples: r.entity_triples || [] });
    setModalOpen(true);
  };

  const handleSave = async () => {
    const values = await form.validateFields();
    if (editing) {
      await api.put(`/content/knowledge/${editing.id}`, values);
    } else {
      await api.post('/content/knowledge', values);
    }
    message.success('保存成功');
    setModalOpen(false);
    load();
  };

  const handleDelete = async (id: number) => {
    await api.delete(`/content/knowledge/${id}`);
    message.success('删除成功');
    load();
  };

  const columns = [
    { title: '企业全称', dataIndex: 'company_full_name' },
    { title: '简称', dataIndex: 'company_short_name' },
    { title: '城市', dataIndex: 'city' },
    { title: '行业', dataIndex: 'industry' },
    { title: '三元组', dataIndex: 'entity_triples', render: (t: Triple[]) => t?.length ? <Tag color="blue">{t.length}个</Tag> : '-' },
    {
      title: '操作', render: (_: any, r: Knowledge) => (
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
        <Button type="primary" icon={<PlusOutlined />} onClick={handleAdd}>新增企业知识库</Button>
        <span style={{ marginLeft: 12, color: '#faad14' }}>⚠ 企业全称在所有平台必须一致</span>
      </div>
      <Table columns={columns} dataSource={list} rowKey="id" loading={loading} pagination={false} />
      <Modal title={editing ? '编辑企业知识库' : '新增企业知识库'} open={modalOpen} onOk={handleSave} onCancel={() => setModalOpen(false)} width={800}>
        <Form form={form} layout="vertical">
          <Form.Item name="company_full_name" label="企业全称（工商一致）" rules={[{ required: true }]}>
            <Input placeholder="如：四川川务财税服务有限公司" />
          </Form.Item>
          <Form.Item name="company_short_name" label="简称">
            <Input placeholder="如：川务财税" />
          </Form.Item>
          <Form.Item name="city" label="所在城市">
            <Input placeholder="如：成都" />
          </Form.Item>
          <Form.Item name="address" label="详细地址">
            <Input placeholder="如：成都市锦江区..." />
          </Form.Item>
          <Form.Item name="industry" label="所属行业">
            <Input placeholder="如：财税服务" />
          </Form.Item>
          <Form.Item name="founded_year" label="成立年份">
            <InputNumber min={1900} max={2030} style={{ width: '100%' }} />
          </Form.Item>
          <Form.Item name="business_scope" label="业务范围（每项一行）">
            <TextArea rows={3} placeholder="代理记账\n税务筹划\n工商注册" />
          </Form.Item>
          <Card title="实体三元组（GEO核心）" size="small" style={{ marginBottom: 16 }}>
            <Form.List name="entity_triples">
              {(fields, { add, remove }) => (
                <>
                  {fields.map(({ key, name }) => (
                    <Space key={key} style={{ display: 'flex', marginBottom: 8 }} align="baseline">
                      <Form.Item name={[name, 'subject']} noStyle><Input placeholder="主语" style={{ width: 120 }} /></Form.Item>
                      <Form.Item name={[name, 'relation']} noStyle><Input placeholder="关系" style={{ width: 120 }} /></Form.Item>
                      <Form.Item name={[name, 'object']} noStyle><Input placeholder="宾语" style={{ width: 200 }} /></Form.Item>
                      <MinusCircleOutlined onClick={() => remove(name)} />
                    </Space>
                  ))}
                  <Button type="dashed" onClick={() => add({ subject: '', relation: '', object: '' })} icon={<PlusCircleOutlined />}>
                    添加三元组
                  </Button>
                </>
              )}
            </Form.List>
          </Card>
          <Form.Item name="intro_text" label="企业介绍">
            <TextArea rows={3} placeholder="企业详细介绍..." />
          </Form.Item>
          <Form.Item name="cases_text" label="成功案例">
            <TextArea rows={3} placeholder="成功案例文本..." />
          </Form.Item>
        </Form>
      </Modal>
    </div>
  );
}
