'use client';

import React, { useState, useEffect } from 'react';
import { Table, Button, Space, Tag, Popconfirm, message, Modal, Form, Input, InputNumber, Select, DatePicker, Tooltip } from 'antd';
import { PlusOutlined, DeleteOutlined, ReloadOutlined, PauseCircleOutlined, PlayCircleOutlined } from '@ant-design/icons';
import api from '@/lib/api';

interface TaskItem {
  id: number;
  userId: string;
  userName?: string;
  startDate?: string;
  endDate?: string;
  totalNum?: number;
  status?: string;
  name?: string;
  createTime?: string;
  generatedNum?: number;
  platformWeights?: any[];
}

interface UserOption {
  id: string;
  username: string;
  level: string;
}

const { RangePicker } = DatePicker;

export default function TaskPage() {
  const [loading, setLoading] = useState(false);
  const [tasks, setTasks] = useState<TaskItem[]>([]);
  const [users, setUsers] = useState<UserOption[]>([]);
  const [modalVisible, setModalVisible] = useState(false);
  const [submitting, setSubmitting] = useState(false);
  const [form] = Form.useForm();
  const [filterUserId, setFilterUserId] = useState<string>('all');

  const fetchTasks = async (userId: string = 'all') => {
    setLoading(true);
    try {
      const params: any = {};
      if (userId !== 'all') params.userId = userId;
      const res = await api.get('/task/list', { params });
      if (res.data?.code === 200) {
        setTasks(res.data.data || []);
      } else {
        message.error(res.data?.message || '获取任务列表失败');
      }
    } catch (e) {
      message.error('获取任务列表失败，请检查云端连接');
    } finally {
      setLoading(false);
    }
  };

  const fetchUsers = async () => {
    try {
      const res = await api.get('/users/queryUserList', { params: { pageNum: 1, pageSize: 999999 } });
      if (res.data?.code === 200) {
        const allUsers = res.data.data?.list || [];
        const userList = allUsers.filter((u: UserOption) => u.username !== 'admin');
        setUsers(userList);
      }
    } catch (e) {
      // 忽略
    }
  };

  useEffect(() => {
    fetchTasks();
    fetchUsers();
  }, []);

  const handleCreate = async (values: any) => {
    setSubmitting(true);
    try {
      const [startAt, endAt] = values.dateRange || [];
      const res = await api.post('/task/rw', {
        userId: values.userId,
        count: values.count,
        startAt: startAt?.format('YYYY-MM-DD'),
        endAt: endAt?.format('YYYY-MM-DD'),
        name: values.name || '',
      });
      if (res.data?.code === 200) {
        message.success('创建成功');
        setModalVisible(false);
        form.resetFields();
        fetchTasks(filterUserId);
      } else {
        message.error(res.data?.message || '创建失败');
      }
    } catch (e) {
      message.error('创建失败');
    } finally {
      setSubmitting(false);
    }
  };

  const handleDelete = async (id: number) => {
    try {
      const res = await api.delete(`/task/delete/${id}`);
      if (res.data?.code === 200) {
        message.success('删除成功');
        fetchTasks(filterUserId);
      } else {
        message.error(res.data?.message || '删除失败');
      }
    } catch (e) {
      message.error('删除失败');
    }
  };

  const handleStatusChange = async (id: number, status: string) => {
    try {
      const res = await api.post('/task/status', { taskId: id, status });
      if (res.data?.code === 200) {
        message.success('状态更新成功');
        fetchTasks(filterUserId);
      } else {
        message.error(res.data?.message || '状态更新失败');
      }
    } catch (e) {
      message.error('状态更新失败');
    }
  };

  const statusTag = (status?: string) => {
    if (!status) return <Tag>未知</Tag>;
    const map: Record<string, { color: string; text: string }> = {
      running: { color: 'processing', text: '运行中' },
      paused: { color: 'warning', text: '已暂停' },
      completed: { color: 'success', text: '已完成' },
      failed: { color: 'error', text: '失败' },
      pending: { color: 'default', text: '等待中' },
    };
    const cfg = map[status] || { color: 'default', text: status };
    return <Tag color={cfg.color}>{cfg.text}</Tag>;
  };

  const columns = [
    { title: 'ID', dataIndex: 'id', width: 100 },
    { title: '任务名称', dataIndex: 'name', width: 150, render: (v: string) => v || '-' },
    {
      title: '用户', dataIndex: 'userName', width: 120,
      render: (v: string, record: TaskItem) => v || record.userId || '-',
    },
    { title: '开始日期', dataIndex: 'startDate', width: 120, render: (v: string) => v || '-' },
    { title: '结束日期', dataIndex: 'endDate', width: 120, render: (v: string) => v || '-' },
    {
      title: '进度', width: 150,
      render: (_: any, record: TaskItem) => {
        const generated = record.generatedNum || 0;
        const total = record.totalNum || 0;
        const pct = total > 0 ? Math.min(100, Math.round((generated / total) * 100)) : 0;
        return (
          <Tooltip title={`${generated} / ${total}`}>
            <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
              <div style={{ flex: 1, height: 8, background: '#f0f0f0', borderRadius: 4, overflow: 'hidden' }}>
                <div style={{ width: `${pct}%`, height: '100%', background: '#1890ff', transition: 'width 0.3s' }} />
              </div>
              <span style={{ fontSize: 12, color: '#666' }}>{generated}/{total}</span>
            </div>
          </Tooltip>
        );
      },
    },
    {
      title: '状态', dataIndex: 'status', width: 100,
      render: (v: string) => statusTag(v),
    },
    { title: '创建时间', dataIndex: 'createTime', width: 180, render: (v: string) => v || '-' },
    {
      title: '操作', width: 200, fixed: 'right' as const,
      render: (_: any, record: TaskItem) => (
        <Space>
          {record.status === 'running' && (
            <Button size="small" icon={<PauseCircleOutlined />} onClick={() => handleStatusChange(record.id, 'paused')}>暂停</Button>
          )}
          {record.status === 'paused' && (
            <Button size="small" type="primary" icon={<PlayCircleOutlined />} onClick={() => handleStatusChange(record.id, 'running')}>恢复</Button>
          )}
          <Popconfirm title="确定删除该任务？" onConfirm={() => handleDelete(record.id)}>
            <Button size="small" danger icon={<DeleteOutlined />}>删除</Button>
          </Popconfirm>
        </Space>
      ),
    },
  ];

  return (
    <div>
      <div style={{ display: 'flex', justifyContent: 'space-between', marginBottom: 16 }}>
        <h2 style={{ margin: 0 }}>数据生成任务</h2>
        <Space>
          <Select
            style={{ width: 180 }}
            value={filterUserId}
            onChange={(v) => { setFilterUserId(v); fetchTasks(v); }}
            options={[{ value: 'all', label: '全部用户' }, ...users.map((u) => ({ value: String(u.id), label: u.username }))]}
          />
          <Button icon={<ReloadOutlined />} onClick={() => fetchTasks(filterUserId)}>刷新</Button>
          <Button type="primary" icon={<PlusOutlined />} onClick={() => setModalVisible(true)}>新建任务</Button>
        </Space>
      </div>

      <Table
        loading={loading}
        dataSource={tasks}
        columns={columns}
        rowKey="id"
        scroll={{ x: 1200 }}
        pagination={{ pageSize: 20, showSizeChanger: true, showTotal: (t) => `共 ${t} 条` }}
      />

      <Modal
        title="新建数据生成任务"
        open={modalVisible}
        onCancel={() => setModalVisible(false)}
        onOk={() => form.submit()}
        confirmLoading={submitting}
        destroyOnClose
        width={500}
      >
        <Form form={form} layout="vertical" onFinish={handleCreate}>
          <Form.Item label="任务名称" name="name">
            <Input placeholder="请输入任务名称（可选）" />
          </Form.Item>
          <Form.Item label="选择用户" name="userId" rules={[{ required: true, message: '请选择用户' }]}>
            <Select
              placeholder="请选择用户"
              options={users.map((u) => ({ value: String(u.id), label: u.username }))}
            />
          </Form.Item>
          <Form.Item label="生成数量" name="count" rules={[{ required: true, message: '请输入生成数量' }]}>
            <InputNumber min={1} max={100000} style={{ width: '100%' }} placeholder="请输入生成数量" />
          </Form.Item>
          <Form.Item label="日期范围" name="dateRange" rules={[{ required: true, message: '请选择日期范围' }]}>
            <RangePicker style={{ width: '100%' }} />
          </Form.Item>
        </Form>
      </Modal>
    </div>
  );
}
