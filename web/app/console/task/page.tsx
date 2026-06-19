'use client';

import React, { useState, useEffect } from 'react';
import { Table, Button, Space, Tag, Popconfirm, message, Modal, Form, Input, InputNumber, Select, DatePicker, Tooltip, Divider, Card, Statistic } from 'antd';
import { PlusOutlined, DeleteOutlined, ReloadOutlined, PauseCircleOutlined, PlayCircleOutlined, EditOutlined, ClearOutlined } from '@ant-design/icons';
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
  platformWeights?: { platform: string; weight: number }[];
  hourWeights?: { hour_slot: number; weight: number }[];
}

// 8个时区：0-3, 3-6, 6-9, 9-12, 12-15, 15-18, 18-21, 21-24
const HOUR_SLOTS = [
  { slot: 0, label: '00:00 - 03:00' },
  { slot: 1, label: '03:00 - 06:00' },
  { slot: 2, label: '06:00 - 09:00' },
  { slot: 3, label: '09:00 - 12:00' },
  { slot: 4, label: '12:00 - 15:00' },
  { slot: 5, label: '15:00 - 18:00' },
  { slot: 6, label: '18:00 - 21:00' },
  { slot: 7, label: '21:00 - 24:00' },
];

interface UserOption {
  id: string;
  username: string;
  level: string;
}

interface PlatformOption {
  name: string;
  pt?: string;
}

const { RangePicker } = DatePicker;

export default function TaskPage() {
  const [loading, setLoading] = useState(false);
  const [tasks, setTasks] = useState<TaskItem[]>([]);
  const [users, setUsers] = useState<UserOption[]>([]);
  const [platforms, setPlatforms] = useState<PlatformOption[]>([]);
  const [modalVisible, setModalVisible] = useState(false);
  const [editModalVisible, setEditModalVisible] = useState(false);
  const [weightsModalVisible, setWeightsModalVisible] = useState(false);
  const [clearModalVisible, setClearModalVisible] = useState(false);
  const [submitting, setSubmitting] = useState(false);
  const [form] = Form.useForm();
  const [editForm] = Form.useForm();
  const [clearForm] = Form.useForm();
  const [filterUserId, setFilterUserId] = useState<string>('all');
  const [editingTask, setEditingTask] = useState<TaskItem | null>(null);
  const [weightsTask, setWeightsTask] = useState<TaskItem | null>(null);
  const [weights, setWeights] = useState<{ platform: string; weight: number }[]>([]);
  const [hourWeightsModalVisible, setHourWeightsModalVisible] = useState(false);
  const [hourWeightsTask, setHourWeightsTask] = useState<TaskItem | null>(null);
  const [hourWeights, setHourWeights] = useState<{ hourSlot: number; weight: number }[]>([]);

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

  const fetchPlatforms = async () => {
    try {
      const res = await api.get('/pt/list');
      if (res.data?.code === 200) {
        const data = res.data.data || [];
        setPlatforms(data.map((p: any) => ({ name: p.pt || p.name, pt: p.pt })));
      }
    } catch (e) {
      // 忽略
    }
  };

  useEffect(() => {
    fetchTasks();
    fetchUsers();
    fetchPlatforms();
  }, []);

  const handleCreate = async (values: any) => {
    setSubmitting(true);
    try {
      const [startAt, endAt] = values.dateRange || [];
      const platformWeights = values.platformWeights || [];
      // 时区权重：表单结构为 { [slot]: { weight: number } }，转换为数组
      const hourWeightsRaw = values.hourWeights || {};
      const hourWeights = HOUR_SLOTS.map((s) => {
        const w = hourWeightsRaw[s.slot];
        return { hourSlot: s.slot, weight: w?.weight || 0 };
      }).filter((w) => w.weight > 0);
      const res = await api.post('/task/rw', {
        userId: values.userId,
        count: values.count,
        startAt: startAt?.format('YYYY-MM-DD'),
        endAt: endAt?.format('YYYY-MM-DD'),
        name: values.name || '',
        platformWeights,
        hourWeights,
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

  // 编辑任务
  const openEdit = (task: TaskItem) => {
    setEditingTask(task);
    editForm.setFieldsValue({
      name: task.name || '',
      count: task.totalNum || 0,
      dateRange: task.startDate && task.endDate ? [task.startDate, task.endDate] : undefined,
    });
    setEditModalVisible(true);
  };

  const handleEdit = async (values: any) => {
    if (!editingTask) return;
    setSubmitting(true);
    try {
      const [startAt, endAt] = values.dateRange || [];
      const res = await api.post('/task/update', {
        taskId: editingTask.id,
        count: values.count,
        startAt: startAt?.format('YYYY-MM-DD'),
        endAt: endAt?.format('YYYY-MM-DD'),
        name: values.name || '',
      });
      if (res.data?.code === 200) {
        message.success('编辑成功');
        setEditModalVisible(false);
        fetchTasks(filterUserId);
      } else {
        message.error(res.data?.message || '编辑失败');
      }
    } catch (e) {
      message.error('编辑失败');
    } finally {
      setSubmitting(false);
    }
  };

  // 平台权重
  const openWeights = (task: TaskItem) => {
    setWeightsTask(task);
    const existingWeights = task.platformWeights || [];
    // 确保所有平台都有权重项
    const allWeights = platforms.map((p) => {
      const existing = existingWeights.find((w) => w.platform === p.name);
      return { platform: p.name, weight: existing?.weight || 0 };
    });
    setWeights(allWeights);
    setWeightsModalVisible(true);
  };

  const handleSaveWeights = async () => {
    if (!weightsTask) return;
    setSubmitting(true);
    try {
      const res = await api.post('/task/weights', {
        taskId: weightsTask.id,
        weights: weights.filter((w) => w.weight > 0),
      });
      if (res.data?.code === 200) {
        message.success('权重保存成功');
        setWeightsModalVisible(false);
        fetchTasks(filterUserId);
      } else {
        message.error(res.data?.message || '保存失败');
      }
    } catch (e) {
      message.error('保存失败');
    } finally {
      setSubmitting(false);
    }
  };

  // 时区权重
  const openHourWeights = (task: TaskItem) => {
    setHourWeightsTask(task);
    const existing = task.hourWeights || [];
    const allHourWeights = HOUR_SLOTS.map((s) => {
      const found = existing.find((w) => w.hour_slot === s.slot);
      return { hourSlot: s.slot, weight: found?.weight || 0 };
    });
    setHourWeights(allHourWeights);
    setHourWeightsModalVisible(true);
  };

  const handleSaveHourWeights = async () => {
    if (!hourWeightsTask) return;
    setSubmitting(true);
    try {
      const res = await api.post('/task/hourWeights', {
        taskId: hourWeightsTask.id,
        weights: hourWeights,
      });
      if (res.data?.code === 200) {
        message.success('时区权重保存成功');
        setHourWeightsModalVisible(false);
        fetchTasks(filterUserId);
      } else {
        message.error(res.data?.message || '保存失败');
      }
    } catch (e) {
      message.error('保存失败');
    } finally {
      setSubmitting(false);
    }
  };

  // 数据清零
  const handleClearData = async (values: any) => {
    setSubmitting(true);
    try {
      const res = await api.post('/data/clear', {
        userId: values.userId || undefined,
        type: values.type,
      });
      if (res.data?.code === 200) {
        message.success(`已清零 ${res.data.data?.cleared || 0} 条数据`);
        setClearModalVisible(false);
        clearForm.resetFields();
      } else {
        message.error(res.data?.message || '清零失败');
      }
    } catch (e) {
      message.error('清零失败');
    } finally {
      setSubmitting(false);
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
      title: '平台权重', width: 120,
      render: (_: any, record: TaskItem) => {
        const ws = record.platformWeights || [];
        if (ws.length === 0) return <Tag>默认均匀</Tag>;
        return (
          <Tooltip title={ws.map((w) => `${w.platform}: ${w.weight}`).join(', ')}>
            <Button size="small" onClick={() => openWeights(record)}>{ws.length}个平台</Button>
          </Tooltip>
        );
      },
    },
    {
      title: '时区权重', width: 120,
      render: (_: any, record: TaskItem) => {
        const hws = record.hourWeights || [];
        const configured = hws.filter((w) => w.weight > 0);
        if (configured.length === 0) return <Tag>默认均匀</Tag>;
        const total = configured.reduce((s, w) => s + w.weight, 0);
        const peak = configured.reduce((m, w) => (w.weight > m.weight ? w : m), configured[0]);
        return (
          <Tooltip title={configured.map((w) => `${HOUR_SLOTS[w.hour_slot]?.label}: ${w.weight}（${Math.round(w.weight / total * 100)}%）`).join('\n')}>
            <Button size="small" onClick={() => openHourWeights(record)}>已配置</Button>
            <div style={{ fontSize: 11, color: '#999', marginTop: 2 }}>峰值: {HOUR_SLOTS[peak.hour_slot]?.label}</div>
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
      title: '操作', width: 360, fixed: 'right' as const,
      render: (_: any, record: TaskItem) => (
        <Space wrap>
          {record.status === 'running' && (
            <Button size="small" icon={<PauseCircleOutlined />} onClick={() => handleStatusChange(record.id, 'paused')}>暂停</Button>
          )}
          {record.status === 'paused' && (
            <Button size="small" type="primary" icon={<PlayCircleOutlined />} onClick={() => handleStatusChange(record.id, 'running')}>恢复</Button>
          )}
          <Button size="small" icon={<EditOutlined />} onClick={() => openEdit(record)}>编辑</Button>
          <Button size="small" onClick={() => openWeights(record)}>平台权重</Button>
          <Button size="small" onClick={() => openHourWeights(record)}>时区权重</Button>
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
          <Button icon={<ClearOutlined />} onClick={() => { clearForm.resetFields(); setClearModalVisible(true); }}>数据清零</Button>
          <Button type="primary" icon={<PlusOutlined />} onClick={() => { form.resetFields(); setModalVisible(true); }}>新建任务</Button>
        </Space>
      </div>

      <Table
        loading={loading}
        dataSource={tasks}
        columns={columns}
        rowKey="id"
        scroll={{ x: 1620 }}
        pagination={{ pageSize: 20, showSizeChanger: true, showTotal: (t) => `共 ${t} 条` }}
      />

      {/* 新建任务弹窗 */}
      <Modal
        title="新建数据生成任务"
        open={modalVisible}
        onCancel={() => setModalVisible(false)}
        onOk={() => form.submit()}
        confirmLoading={submitting}
        destroyOnClose
        width={700}
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
          <Form.Item
            label="日期范围"
            name="dateRange"
            rules={[{ required: true, message: '请选择日期范围' }]}
            extra="开始时间可设为早于当前日期，系统将自动补齐从开始时间到当前的数据"
          >
            <RangePicker style={{ width: '100%' }} />
          </Form.Item>
          <Divider>平台权重（可选，不填则均匀分配）</Divider>
          <Form.List name="platformWeights">
            {(fields, { add, remove }) => (
              <>
                {fields.map(({ key, name, ...restField }) => (
                  <Space key={key} style={{ display: 'flex', marginBottom: 8 }} align="baseline">
                    <Form.Item {...restField} name={[name, 'platform']} rules={[{ required: true, message: '选择平台' }]}>
                      <Select style={{ width: 150 }} placeholder="选择平台" options={platforms.map((p) => ({ value: p.name, label: p.name }))} />
                    </Form.Item>
                    <Form.Item {...restField} name={[name, 'weight']} rules={[{ required: true, message: '输入权重' }]}>
                      <InputNumber min={1} max={100} placeholder="权重" style={{ width: 100 }} />
                    </Form.Item>
                    <Button danger size="small" icon={<DeleteOutlined />} onClick={() => remove(name)} />
                  </Space>
                ))}
                <Button type="dashed" block icon={<PlusOutlined />} onClick={() => add()}>添加平台权重</Button>
              </>
            )}
          </Form.List>
          <Divider>时区权重（可选，控制数据主要在哪个时段生成）</Divider>
          <div style={{ marginBottom: 12, padding: 12, background: '#f6f8fa', borderRadius: 4, fontSize: 13, color: '#666' }}>
            按24小时每3小时一个时段设置权重。权重为相对比例，权重为0表示该时段不生成数据。不填则全天均匀生成。
          </div>
          <div style={{ display: 'grid', gridTemplateColumns: 'repeat(2, 1fr)', gap: 8 }}>
            {HOUR_SLOTS.map((s) => (
              <Form.Item key={s.slot} label={s.label} name={['hourWeights', s.slot, 'weight']} initialValue={0} style={{ marginBottom: 8 }}>
                <InputNumber min={0} max={100} placeholder="0" style={{ width: '100%' }} />
              </Form.Item>
            ))}
          </div>
        </Form>
      </Modal>

      {/* 编辑任务弹窗 */}
      <Modal
        title="编辑任务"
        open={editModalVisible}
        onCancel={() => setEditModalVisible(false)}
        onOk={() => editForm.submit()}
        confirmLoading={submitting}
        destroyOnClose
        width={500}
      >
        <div style={{ marginBottom: 16, padding: 12, background: '#fff7e6', borderRadius: 4, fontSize: 13, color: '#fa8c16' }}>
          编辑任务会影响后续未生成的数据。已生成的数据不会受影响。
        </div>
        <Form form={editForm} layout="vertical" onFinish={handleEdit}>
          <Form.Item label="任务名称" name="name">
            <Input placeholder="请输入任务名称（可选）" />
          </Form.Item>
          <Form.Item label="生成总数" name="count" rules={[{ required: true, message: '请输入生成数量' }]}>
            <InputNumber min={1} max={100000} style={{ width: '100%' }} placeholder="请输入生成总数" />
          </Form.Item>
          <Form.Item label="日期范围" name="dateRange" rules={[{ required: true, message: '请选择日期范围' }]}>
            <RangePicker style={{ width: '100%' }} />
          </Form.Item>
        </Form>
      </Modal>

      {/* 平台权重弹窗 */}
      <Modal
        title={`平台权重配置 - 任务 ${weightsTask?.id || ''}`}
        open={weightsModalVisible}
        onCancel={() => setWeightsModalVisible(false)}
        onOk={handleSaveWeights}
        confirmLoading={submitting}
        destroyOnClose
        width={500}
      >
        <div style={{ marginBottom: 16, padding: 12, background: '#f6f8fa', borderRadius: 4, fontSize: 13, color: '#666' }}>
          权重为相对比例。例如平台A权重2、平台B权重3，则数据按 2:3 分配。权重为0表示该平台不生成数据。
        </div>
        {weights.map((w, idx) => (
          <Space key={w.platform} style={{ display: 'flex', marginBottom: 8 }} align="baseline">
            <span style={{ width: 120, display: 'inline-block' }}>{w.platform}：</span>
            <InputNumber
              min={0}
              max={100}
              value={w.weight}
              onChange={(v) => {
                const newWeights = [...weights];
                newWeights[idx] = { ...newWeights[idx], weight: v || 0 };
                setWeights(newWeights);
              }}
              style={{ width: 120 }}
            />
          </Space>
        ))}
      </Modal>

      {/* 时区权重弹窗 */}
      <Modal
        title={`时区权重配置 - 任务 ${hourWeightsTask?.id || ''}`}
        open={hourWeightsModalVisible}
        onCancel={() => setHourWeightsModalVisible(false)}
        onOk={handleSaveHourWeights}
        confirmLoading={submitting}
        destroyOnClose
        width={600}
      >
        <div style={{ marginBottom: 16, padding: 12, background: '#f6f8fa', borderRadius: 4, fontSize: 13, color: '#666' }}>
          按24小时每3小时一个时段设置权重。权重为相对比例，例如时段A权重2、时段B权重3，则数据按 2:3 分配到对应时段。权重为0表示该时段不生成数据。全部为0或不填则全天均匀生成。
        </div>
        <div style={{ display: 'grid', gridTemplateColumns: 'repeat(2, 1fr)', gap: 12 }}>
          {hourWeights.map((hw, idx) => {
            const slot = HOUR_SLOTS.find((s) => s.slot === hw.hourSlot);
            const total = hourWeights.reduce((s, w) => s + (w.weight || 0), 0);
            const pct = total > 0 && hw.weight > 0 ? Math.round(hw.weight / total * 100) : 0;
            return (
              <div key={hw.hourSlot} style={{ padding: 8, border: '1px solid #f0f0f0', borderRadius: 4 }}>
                <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: 4 }}>
                  <span style={{ fontSize: 13, fontWeight: 500 }}>{slot?.label}</span>
                  {pct > 0 && <Tag color="blue">{pct}%</Tag>}
                </div>
                <InputNumber
                  min={0}
                  max={100}
                  value={hw.weight}
                  onChange={(v) => {
                    const newHw = [...hourWeights];
                    newHw[idx] = { ...newHw[idx], weight: v || 0 };
                    setHourWeights(newHw);
                  }}
                  style={{ width: '100%' }}
                  placeholder="0"
                />
              </div>
            );
          })}
        </div>
        <div style={{ marginTop: 12, padding: 8, background: '#e6f7ff', borderRadius: 4, fontSize: 12, color: '#1890ff' }}>
          提示：建议根据目标用户活跃时段设置较高权重，例如工作时间段（09:00-18:00）可设置较高权重。
        </div>
      </Modal>

      {/* 数据清零弹窗 */}
      <Modal
        title="数据清零"
        open={clearModalVisible}
        onCancel={() => setClearModalVisible(false)}
        onOk={() => clearForm.submit()}
        confirmLoading={submitting}
        destroyOnClose
        width={500}
      >
        <div style={{ marginBottom: 16, padding: 12, background: '#fff1f0', borderRadius: 4, fontSize: 13, color: '#cf1322' }}>
          <b>警告：</b>此操作不可恢复！请谨慎操作。
        </div>
        <Form form={clearForm} layout="vertical" onFinish={handleClearData}>
          <Form.Item label="清零类型" name="type" rules={[{ required: true, message: '请选择清零类型' }]} initialValue="report">
            <Select
              options={[
                { value: 'report', label: 'GEO报告数据（收录记录）' },
                { value: 'keyword', label: '关键词配置数据（品牌词、核心词、蒸馏关键词）' },
              ]}
            />
          </Form.Item>
          <Form.Item label="清零范围" name="userId">
            <Select
              allowClear
              placeholder="全部用户（不选则清零所有用户数据）"
              options={users.map((u) => ({ value: String(u.id), label: u.username }))}
            />
          </Form.Item>
        </Form>
      </Modal>
    </div>
  );
}
