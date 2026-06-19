'use client';

import React, { useState, useEffect } from 'react';
import { Table, Modal, Form, Input, Button, Space, Tag, Popconfirm, message, Tabs, Select, Card } from 'antd';
import { PlusOutlined, EditOutlined, DeleteOutlined } from '@ant-design/icons';
import api from '@/lib/api';

interface UserItem {
  id: number;
  username: string;
  phone?: string;
  email?: string;
  level?: string;
  dateTime?: string;
  url?: string;
  address?: string;
  cid?: string;
}

export default function UsersPage() {
  const [loading, setLoading] = useState(false);
  const [users, setUsers] = useState<UserItem[]>([]);
  const [modalVisible, setModalVisible] = useState(false);
  const [editingUser, setEditingUser] = useState<UserItem | null>(null);
  const [submitting, setSubmitting] = useState(false);
  const [activeTab, setActiveTab] = useState('customer');
  const [form] = Form.useForm();

  const fetchUsers = async () => {
    setLoading(true);
    try {
      const res = await api.get('/users/queryUserList', { params: { pageNum: 1, pageSize: 999999 } });
      if (res.data?.code === 200) {
        const list = Array.isArray(res.data.data) ? res.data.data : (res.data.data?.list || []);
        setUsers(list);
      } else {
        message.error(res.data?.message || '获取用户列表失败');
      }
    } catch (e) {
      message.error('获取用户列表失败，请检查云端连接');
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => {
    fetchUsers();
  }, []);

  const handleSubmit = async (values: any) => {
    setSubmitting(true);
    try {
      if (editingUser) {
        const res = await api.post('/users/update', { ...values, id: editingUser.id });
        if (res.data?.code === 200) {
          message.success('更新成功');
          setModalVisible(false);
          fetchUsers();
        } else {
          message.error(res.data?.message || '更新失败');
        }
      } else {
        const res = await api.post('/users/create', values);
        if (res.data?.code === 200) {
          message.success('创建成功');
          setModalVisible(false);
          fetchUsers();
        } else {
          message.error(res.data?.message || '创建失败');
        }
      }
    } catch (e) {
      message.error('操作失败，请检查云端连接');
    } finally {
      setSubmitting(false);
    }
  };

  const handleDelete = async (user: UserItem) => {
    try {
      const res = await api.post('/users/delete', { id: user.id });
      if (res.data?.code === 200) {
        message.success('删除成功');
        fetchUsers();
      } else {
        message.error(res.data?.message || '删除失败');
      }
    } catch (e) {
      message.error('删除失败');
    }
  };

  const openCreate = (level: string) => {
    setEditingUser(null);
    form.resetFields();
    form.setFieldsValue({ level });
    setModalVisible(true);
  };

  const openEdit = (user: UserItem) => {
    setEditingUser(user);
    form.setFieldsValue(user);
    setModalVisible(true);
  };

  const adminUsers = users.filter((u) => u.level === '1' || u.level === 'admin');
  const customerUsers = users.filter((u) => u.level !== '1' && u.level !== 'admin');

  const baseColumns = [
    { title: 'ID', dataIndex: 'id', width: 80 },
    { title: '用户名', dataIndex: 'username', width: 150 },
    {
      title: '电话', dataIndex: 'phone', width: 150,
      render: (v: string) => v || '-',
    },
    {
      title: '邮箱', dataIndex: 'email', width: 200,
      render: (v: string) => v || '-',
    },
  ];

  const adminColumns = [
    ...baseColumns,
    {
      title: '类型', dataIndex: 'level', width: 100,
      render: () => <Tag color="magenta">管理员</Tag>,
    },
    {
      title: '注册时间', dataIndex: 'dateTime', width: 180,
      render: (v: string) => v || '-',
    },
    {
      title: '操作', width: 150, fixed: 'right' as const,
      render: (_: any, record: UserItem) => (
        <Space>
          <Button size="small" icon={<EditOutlined />} onClick={() => openEdit(record)}>编辑</Button>
          <Popconfirm title="确定要删除该管理员吗？" onConfirm={() => handleDelete(record)}>
            <Button size="small" danger icon={<DeleteOutlined />}>删除</Button>
          </Popconfirm>
        </Space>
      ),
    },
  ];

  const customerColumns = [
    ...baseColumns,
    {
      title: '网址', dataIndex: 'url', width: 220,
      render: (v: string) => v ? <a href={v} target="_blank" rel="noreferrer">{v}</a> : '-',
    },
    {
      title: '地址', dataIndex: 'address', width: 200,
      render: (v: string) => v || '-',
    },
    {
      title: '类型', dataIndex: 'level', width: 100,
      render: () => <Tag color="blue">客户</Tag>,
    },
    {
      title: '注册时间', dataIndex: 'dateTime', width: 180,
      render: (v: string) => v || '-',
    },
    {
      title: '操作', width: 150, fixed: 'right' as const,
      render: (_: any, record: UserItem) => (
        <Space>
          <Button size="small" icon={<EditOutlined />} onClick={() => openEdit(record)}>编辑</Button>
          <Popconfirm title="确定要删除该客户吗？" onConfirm={() => handleDelete(record)}>
            <Button size="small" danger icon={<DeleteOutlined />}>删除</Button>
          </Popconfirm>
        </Space>
      ),
    },
  ];

  const isEditingAdmin = editingUser?.level === '1' || editingUser?.level === 'admin';

  return (
    <div>
      <div className="console-page-title">
        <span className="console-page-title-text">用户管理</span>
      </div>

      <Tabs
        activeKey={activeTab}
        onChange={setActiveTab}
        items={[
          {
            key: 'customer',
            label: <span>客户 <Tag color="blue" style={{ marginLeft: 4 }}>{customerUsers.length}</Tag></span>,
            children: (
              <div>
                <div style={{ marginBottom: 16 }}>
                  <Button type="primary" icon={<PlusOutlined />} onClick={() => openCreate('0')}>新增客户</Button>
                </div>
                <Card size="small">
                  <Table
                    loading={loading}
                    dataSource={customerUsers}
                    columns={customerColumns}
                    rowKey="id"
                    scroll={{ x: 1200 }}
                    pagination={{ pageSize: 20, showSizeChanger: true, showTotal: (t) => `共 ${t} 条` }}
                  />
                </Card>
              </div>
            ),
          },
          {
            key: 'admin',
            label: <span>管理员 <Tag color="magenta" style={{ marginLeft: 4 }}>{adminUsers.length}</Tag></span>,
            children: (
              <div>
                <div style={{ marginBottom: 16 }}>
                  <Button type="primary" icon={<PlusOutlined />} onClick={() => openCreate('1')}>新增管理员</Button>
                </div>
                <Card size="small">
                  <Table
                    loading={loading}
                    dataSource={adminUsers}
                    columns={adminColumns}
                    rowKey="id"
                    scroll={{ x: 1000 }}
                    pagination={{ pageSize: 20, showSizeChanger: true, showTotal: (t) => `共 ${t} 条` }}
                  />
                </Card>
              </div>
            ),
          },
        ]}
      />

      <Modal
        title={editingUser ? `编辑${isEditingAdmin ? '管理员' : '客户'}` : (activeTab === 'admin' ? '新增管理员' : '新增客户')}
        open={modalVisible}
        onCancel={() => setModalVisible(false)}
        onOk={() => form.submit()}
        confirmLoading={submitting}
        destroyOnClose
        width={600}
      >
        <Form form={form} layout="vertical" onFinish={handleSubmit}>
          <Form.Item label="用户名" name="username" rules={[{ required: true, message: '请输入用户名' }]}>
            <Input placeholder="请输入用户名" />
          </Form.Item>
          <Form.Item label="密码" name="password">
            <Input.Password placeholder={editingUser ? '不修改请留空' : '请输入密码'} />
          </Form.Item>
          <Form.Item label="电话" name="phone">
            <Input placeholder="请输入电话" />
          </Form.Item>
          <Form.Item label="邮箱" name="email">
            <Input placeholder="请输入邮箱" />
          </Form.Item>
          {/* 客户独有字段 */}
          {(!isEditingAdmin) && (
            <>
              <Form.Item label="网址" name="url">
                <Input placeholder="请输入网址，例如 https://example.com" />
              </Form.Item>
              <Form.Item label="地址" name="address">
                <Input placeholder="请输入地址" />
              </Form.Item>
            </>
          )}
          <Form.Item label="类型" name="level" rules={[{ required: true, message: '请选择类型' }]} initialValue="0">
            <Select
              style={{ width: '100%' }}
              options={[
                { value: '1', label: '管理员' },
                { value: '0', label: '客户' },
              ]}
            />
          </Form.Item>
        </Form>
      </Modal>
    </div>
  );
}
