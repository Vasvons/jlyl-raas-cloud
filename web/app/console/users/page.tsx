'use client';

import React, { useState, useEffect } from 'react';
import { Table, Modal, Form, Input, Button, Space, Tag, Popconfirm, message } from 'antd';
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

  const columns = [
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
    {
      title: '类型', dataIndex: 'level', width: 100,
      render: (v: string) => {
        const isAdmin = v === '1' || v === 'admin';
        return <Tag color={isAdmin ? 'magenta' : 'blue'}>{isAdmin ? '管理员' : '客户'}</Tag>;
      },
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
          <Popconfirm title="确定要删除该用户吗？" onConfirm={() => handleDelete(record)}>
            <Button size="small" danger icon={<DeleteOutlined />}>删除</Button>
          </Popconfirm>
        </Space>
      ),
    },
  ];

  return (
    <div>
      <div style={{ display: 'flex', justifyContent: 'space-between', marginBottom: 16 }}>
        <h2 style={{ margin: 0 }}>用户管理</h2>
        <Space>
          <Button type="primary" icon={<PlusOutlined />} onClick={() => openCreate('1')}>新增管理员</Button>
          <Button icon={<PlusOutlined />} onClick={() => openCreate('0')}>新增客户</Button>
        </Space>
      </div>
      <Table
        loading={loading}
        dataSource={users}
        columns={columns}
        rowKey="id"
        scroll={{ x: 1000 }}
        pagination={{ pageSize: 20, showSizeChanger: true, showTotal: (t) => `共 ${t} 条` }}
      />
      <Modal
        title={editingUser ? '编辑用户' : '新增用户'}
        open={modalVisible}
        onCancel={() => setModalVisible(false)}
        onOk={() => form.submit()}
        confirmLoading={submitting}
        destroyOnClose
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
          <Form.Item label="类型" name="level" rules={[{ required: true, message: '请选择类型' }]} initialValue="0">
            <select style={{ width: '100%', padding: '6px 12px', border: '1px solid #d9d9d9', borderRadius: 4 }}>
              <option value="1">管理员</option>
              <option value="0">客户</option>
            </select>
          </Form.Item>
        </Form>
      </Modal>
    </div>
  );
}
