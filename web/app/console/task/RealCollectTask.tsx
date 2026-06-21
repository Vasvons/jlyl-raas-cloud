'use client';

import React, { useState, useEffect, useCallback } from 'react';
import { Table, Card, Button, Modal, Form, Input, Select, TimePicker, Tag, Space, message, Popconfirm, Checkbox, Row, Col } from 'antd';
import { PlusOutlined, EditOutlined, PauseOutlined, CaretRightOutlined, ThunderboltOutlined, DeleteOutlined } from '@ant-design/icons';
import dayjs from 'dayjs';
import api from '@/lib/api';

const { Option } = Select;

export default function RealCollectTask() {
  const [loading, setLoading] = useState(false);
  const [data, setData] = useState<any[]>([]);
  const [users, setUsers] = useState<any[]>([]);
  const [platforms, setPlatforms] = useState<any[]>([]);
  const [modalVisible, setModalVisible] = useState(false);
  const [editingTask, setEditingTask] = useState<any>(null);
  const [form] = Form.useForm();
  const [submitting, setSubmitting] = useState(false);

  const loadData = useCallback(async () => {
    setLoading(true);
    try {
      const res = await api.get('/real-collect/tasks');
      if (res.data?.code === 200) {
        setData(res.data.data || []);
      }
    } catch (e: any) {
      message.error(e?.response?.data?.message || '加载失败');
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    loadData();
    api.get('/users/queryUserList').then(res => {
      if (res.data?.code === 200) {
        setUsers((res.data.data?.list || []).filter((u: any) => u.level === '0'));
      }
    }).catch(() => {});
    api.get('/pt/list').then(res => {
      if (res.data?.code === 200) {
        setPlatforms(res.data.data || []);
      }
    }).catch(() => {});
  }, [loadData]);

  const handleAdd = () => {
    setEditingTask(null);
    form.resetFields();
    form.setFieldsValue({
      keywordType: 0,
      enqueueTime: dayjs('02:00', 'HH:mm'),
    });
    setModalVisible(true);
  };

  const handleEdit = (record: any) => {
    setEditingTask(record);
    // 从cron表达式解析入队时间（cron格式: m h * * *）
    let enqueueTime = dayjs('02:00', 'HH:mm');
    if (record.cron_expr) {
      const parts = record.cron_expr.split(' ');
      if (parts.length >= 2) {
        const minute = parseInt(parts[0]) || 0;
        const hour = parseInt(parts[1]) || 2;
        enqueueTime = dayjs().hour(hour).minute(minute);
      }
    }
    form.setFieldsValue({
      ...record,
      userId: record.user_id,
      taskName: record.task_name,
      keywordType: record.keyword_type,
      platforms: record.platforms,
      enqueueTime,
    });
    setModalVisible(true);
  };

  const handleSubmit = async () => {
    try {
      const values = await form.validateFields();
      setSubmitting(true);

      // 队列模式：每天入队，入队时间转为cron表达式
      const time = values.enqueueTime as dayjs.Dayjs;
      const cronExpr = `${time.minute()} ${time.hour()} * * *`;

      const payload = {
        userId: values.userId,
        taskName: values.taskName,
        keywordType: values.keywordType,
        platforms: values.platforms,
        cronExpr,
      };

      if (editingTask) {
        await api.put(`/real-collect/tasks/${editingTask.id}`, payload);
        message.success('更新成功');
      } else {
        await api.post('/real-collect/tasks', payload);
        message.success('创建成功');
      }
      setModalVisible(false);
      loadData();
    } catch (e: any) {
      if (e.errorFields) return;
      message.error(e?.response?.data?.message || '操作失败');
    } finally {
      setSubmitting(false);
    }
  };

  const handlePause = async (id: number) => {
    try {
      await api.post(`/real-collect/tasks/${id}/pause`);
      message.success('已暂停');
      loadData();
    } catch (e: any) {
      message.error(e?.response?.data?.message || '操作失败');
    }
  };

  const handleResume = async (id: number) => {
    try {
      await api.post(`/real-collect/tasks/${id}/resume`);
      message.success('已恢复');
      loadData();
    } catch (e: any) {
      message.error(e?.response?.data?.message || '操作失败');
    }
  };

  const handleRunNow = async (id: number) => {
    try {
      const res = await api.post(`/real-collect/tasks/${id}/run`);
      if (res.data?.code === 200) {
        message.success('任务已加入队列（高优先级），Worker将立即消费执行');
        loadData();
      }
    } catch (e: any) {
      message.error(e?.response?.data?.message || '执行失败');
    }
  };

  const handleDelete = async (id: number) => {
    try {
      await api.delete(`/real-collect/tasks/${id}`);
      message.success('已删除');
      loadData();
    } catch (e: any) {
      message.error(e?.response?.data?.message || '删除失败');
    }
  };

  // 从cron表达式解析显示用的入队时间
  const formatCronTime = (cronExpr: string) => {
    if (!cronExpr) return '-';
    const parts = cronExpr.split(' ');
    if (parts.length >= 2) {
      const minute = parts[0].padStart(2, '0');
      const hour = parts[1].padStart(2, '0');
      return `${hour}:${minute}`;
    }
    return cronExpr;
  };

  const columns = [
    { title: '任务名称', dataIndex: 'task_name', key: 'task_name', width: 150 },
    {
      title: '用户', dataIndex: 'user_id', key: 'user_id', width: 120,
      render: (userId: string) => users.find(u => String(u.id) === userId)?.username || userId
    },
    {
      title: '词库', dataIndex: 'keyword_type', key: 'keyword_type', width: 80,
      render: (v: number) => v === 1 ? <Tag color="blue">品牌词</Tag> : <Tag>蒸馏词</Tag>
    },
    {
      title: '平台', dataIndex: 'platforms', key: 'platforms', width: 200,
      render: (platforms: string[]) => platforms?.map(p => <Tag key={p}>{p}</Tag>)
    },
    {
      title: '入队时间', dataIndex: 'cron_expr', key: 'cron_expr', width: 100,
      render: (cronExpr: string) => `每天 ${formatCronTime(cronExpr)}`
    },
    {
      title: '上次执行', key: 'last_run', width: 200,
      render: (_: any, record: any) => record.last_run_time
        ? `${dayjs(record.last_run_time).format('MM-DD HH:mm')} ${record.last_run_status === 'success' ? '✓' : record.last_run_status === 'failed' ? '✗' : '...'} ${record.last_run_record_count || 0}条`
        : '-'
    },
    {
      title: '状态', dataIndex: 'status', key: 'status', width: 80,
      render: (status: string) => status === 'active'
        ? <Tag color="green">运行中</Tag>
        : status === 'paused' ? <Tag color="orange">已暂停</Tag> : <Tag>{status}</Tag>
    },
    {
      title: '操作', key: 'action', width: 240,
      render: (_: any, record: any) => (
        <Space size="small">
          <Button type="link" size="small" icon={<ThunderboltOutlined />} onClick={() => handleRunNow(record.id)}>立即执行</Button>
          {record.status === 'active'
            ? <Button type="link" size="small" icon={<PauseOutlined />} onClick={() => handlePause(record.id)}>暂停</Button>
            : <Button type="link" size="small" icon={<CaretRightOutlined />} onClick={() => handleResume(record.id)}>恢复</Button>
          }
          <Button type="link" size="small" icon={<EditOutlined />} onClick={() => handleEdit(record)}>编辑</Button>
          <Popconfirm title="确定删除此任务？" onConfirm={() => handleDelete(record.id)}>
            <Button type="link" size="small" danger icon={<DeleteOutlined />}>删除</Button>
          </Popconfirm>
        </Space>
      )
    },
  ];

  return (
    <div>
      <Card>
        <div style={{ marginBottom: 16 }}>
          <Button type="primary" icon={<PlusOutlined />} onClick={handleAdd}>新建任务</Button>
          <span style={{ marginLeft: 12, color: '#999', fontSize: 13 }}>
            队列模式：任务每天按设定时间自动入队，Worker自动消费执行
          </span>
        </div>
        <Table
          columns={columns}
          dataSource={data}
          rowKey="id"
          loading={loading}
          pagination={false}
          scroll={{ x: 1200 }}
        />
      </Card>

      <Modal
        title={editingTask ? '编辑任务' : '新建任务'}
        open={modalVisible}
        onOk={handleSubmit}
        onCancel={() => setModalVisible(false)}
        confirmLoading={submitting}
        width={600}
      >
        <Form form={form} layout="vertical">
          <Form.Item name="taskName" label="任务名称" rules={[{ required: true, message: '请输入任务名称' }]}>
            <Input placeholder="如: 川务财税每日品牌词查询" />
          </Form.Item>
          <Form.Item name="userId" label="选择用户" rules={[{ required: true, message: '请选择用户' }]}>
            <Select placeholder="选择用户">
              {users.map(u => <Option key={u.id} value={String(u.id)}>{u.username}</Option>)}
            </Select>
          </Form.Item>
          <Form.Item name="keywordType" label="词库类型" rules={[{ required: true }]}>
            <Select>
              <Option value={0}>蒸馏词库</Option>
              <Option value={1}>品牌词库</Option>
            </Select>
          </Form.Item>
          <Form.Item name="platforms" label="查询平台（点选）" rules={[{ required: true, message: '请至少选择一个平台' }]}>
            <Checkbox.Group style={{ width: '100%' }}>
              <Row gutter={[8, 8]}>
                {platforms.map(p => (
                  <Col key={p.pt} span={6}>
                    <Checkbox value={p.pt} style={{ fontSize: 13 }}>{p.pt}</Checkbox>
                  </Col>
                ))}
              </Row>
            </Checkbox.Group>
          </Form.Item>
          <Form.Item name="enqueueTime" label="每天入队时间" rules={[{ required: true, message: '请选择入队时间' }]}>
            <TimePicker format="HH:mm" />
          </Form.Item>
          <div style={{ color: '#999', fontSize: 12 }}>
            说明：任务每天在设定的时间自动入队，Worker按队列顺序消费执行。
          </div>
        </Form>
      </Modal>
    </div>
  );
}
