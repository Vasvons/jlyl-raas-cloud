'use client';

import React, { useState, useEffect, useCallback, useRef } from 'react';
import { Table, Card, Button, Modal, Form, Input, Select, Tag, Space, message, Popconfirm, Checkbox, Row, Col } from 'antd';
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
  const [progressMap, setProgressMap] = useState<Record<number, any>>({});
  const progressTimerRef = useRef<ReturnType<typeof setInterval> | null>(null);

  const loadData = useCallback(async () => {
    setLoading(true);
    try {
      const res = await api.get('/real-collect/tasks');
      if (res.data?.code === 200) {
        const tasks = res.data.data || [];
        setData(tasks);
        // 并行加载所有 active 任务的分片进度
        await refreshProgress(tasks);
      }
    } catch (e: any) {
      message.error(e?.response?.data?.message || '加载失败');
    } finally {
      setLoading(false);
    }
  }, []);

  // 刷新所有 active 任务的分片进度（供定时轮询调用）
  const refreshProgress = useCallback(async (tasks?: any[]) => {
    const taskList = tasks || data;
    const activeTasks = taskList.filter((t: any) => t.status === 'active');
    if (activeTasks.length === 0) {
      setProgressMap({});
      return;
    }
    const progressResults = await Promise.all(
      activeTasks.map((t: any) =>
        api.get(`/real-collect/tasks/${t.id}/progress`).then(r => [t.id, r.data?.data]).catch(() => [t.id, null])
      )
    );
    const newMap: Record<number, any> = {};
    for (const [id, progress] of progressResults) {
      if (progress) newMap[id as number] = progress;
    }
    setProgressMap(newMap);
  }, [data]);

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

    // 定时轮询进度（每5秒刷新一次，实时显示当前分片和关键词进度）
    progressTimerRef.current = setInterval(() => {
      refreshProgress();
    }, 5000);

    return () => {
      if (progressTimerRef.current) {
        clearInterval(progressTimerRef.current);
        progressTimerRef.current = null;
      }
    };
  }, [loadData, refreshProgress]);

  const handleAdd = () => {
    setEditingTask(null);
    form.resetFields();
    form.setFieldsValue({
      keywordType: 0,
    });
    setModalVisible(true);
  };

  const handleEdit = (record: any) => {
    setEditingTask(record);
    form.setFieldsValue({
      ...record,
      userId: record.user_id,
      taskName: record.task_name,
      keywordType: record.keyword_type,
      platforms: record.platforms,
    });
    setModalVisible(true);
  };

  const handleSubmit = async () => {
    try {
      const values = await form.validateFields();
      setSubmitting(true);

      const payload = {
        userId: values.userId,
        taskName: values.taskName,
        keywordType: values.keywordType,
        platforms: values.platforms,
        cronExpr: '0 0 * * *',
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
      title: '上次执行', key: 'last_run', width: 200,
      render: (_: any, record: any) => record.last_run_time
        ? `${dayjs(record.last_run_time).format('MM-DD HH:mm')} ${record.last_run_status === 'success' ? '✓' : record.last_run_status === 'failed' ? '✗' : record.last_run_status === 'running' ? '⟳' : '...'} ${record.last_run_record_count || 0}条`
        : '-'
    },
    {
      title: '状态', key: 'status', width: 100,
      render: (_: any, record: any) => {
        if (record.status === 'paused') return <Tag color="orange">已暂停</Tag>;
        if (record.status === 'deleted') return <Tag color="red">已删除</Tag>;
        // status === 'active'，根据 last_run_status 细分
        if (record.last_run_status === 'running') return <Tag color="processing">执行中</Tag>;
        if (record.last_run_status === 'success') return <Tag color="green">已完成</Tag>;
        if (record.last_run_status === 'failed') return <Tag color="red">执行失败</Tag>;
        if (record.last_run_status === 'queued') return <Tag color="blue">已入队</Tag>;
        return <Tag color="default">待执行</Tag>;
      }
    },
    {
      title: '当前轮次进度', key: 'progress', width: 220,
      render: (_: any, record: any) => {
        const p = progressMap[record.id];
        if (!p || record.status !== 'active') return '-';
        const total = p.totalShards || 0;
        const completed = p.completedShards || 0;
        const running = p.runningShards || 0;
        const pending = p.pendingShards || 0;
        const failed = p.failedShards || 0;
        const percent = total > 0 ? Math.round((completed / total) * 100) : 0;
        // 当前正在执行的分片和关键词进度
        const curShardIdx = p.currentShardIndex || 0;
        const curKwIdx = p.currentKeywordIndex ?? -1;
        const curShardKwCount = p.currentShardKeywordCount || 0;
        return (
          <div style={{ fontSize: 12 }}>
            <div>第 {p.roundNo || 0} 轮 · {percent}%</div>
            <div style={{ color: '#999' }}>
              {completed}/{total} 分片
              {running > 0 && <span style={{ color: '#1677ff' }}> · {running}执行</span>}
              {pending > 0 && <span style={{ color: '#faad14' }}> · {pending}待执行</span>}
              {failed > 0 && <span style={{ color: '#ff4d4f' }}> · {failed}失败</span>}
            </div>
            {curShardIdx > 0 && curShardKwCount > 0 && (
              <div style={{ color: '#1677ff' }}>
                分片 {curShardIdx}/{total} · 关键词 {Math.min(curKwIdx + 1, curShardKwCount)}/{curShardKwCount}
              </div>
            )}
          </div>
        );
      }
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
            循环模式：任务24小时持续执行，上一轮100%完成后自动启动下一轮
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
          <div style={{ color: '#999', fontSize: 12 }}>
            说明：任务启动后24小时循环执行，上一轮100%完成后自动启动下一轮。
          </div>
        </Form>
      </Modal>
    </div>
  );
}
