'use client';

import React, { useState, useEffect } from 'react';
import { Table, Button, Space, Tag, Popconfirm, message, Modal, Form, Input, InputNumber, Select, DatePicker, Divider, Row, Col, Progress } from 'antd';
import { PlusOutlined, DeleteOutlined, ReloadOutlined, PauseCircleOutlined, PlayCircleOutlined, EditOutlined, CopyOutlined, ThunderboltOutlined, BugOutlined } from '@ant-design/icons';
import dayjs from 'dayjs';
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

export default function GeneratedDataTask() {
  const [loading, setLoading] = useState(false);
  const [tasks, setTasks] = useState<TaskItem[]>([]);
  const [users, setUsers] = useState<UserOption[]>([]);
  const [platforms, setPlatforms] = useState<PlatformOption[]>([]);
  const [modalVisible, setModalVisible] = useState(false);
  const [editModalVisible, setEditModalVisible] = useState(false);
  const [submitting, setSubmitting] = useState(false);
  const [form] = Form.useForm();
  const [editForm] = Form.useForm();
  const [filterUserId, setFilterUserId] = useState<string>('all');
  const [editingTask, setEditingTask] = useState<TaskItem | null>(null);
  const [diagnoseVisible, setDiagnoseVisible] = useState(false);
  const [diagnoseData, setDiagnoseData] = useState<any>(null);
  const [diagnoseLoading, setDiagnoseLoading] = useState(false);
  const [triggering, setTriggering] = useState<number | null>(null);

  const [newPlatformWeights, setNewPlatformWeights] = useState<{ platform: string; weight: number }[]>([]);
  const [newHourWeights, setNewHourWeights] = useState<{ hourSlot: number; weight: number }[]>([]);
  const [editPlatformWeights, setEditPlatformWeights] = useState<{ platform: string; weight: number }[]>([]);
  const [editHourWeights, setEditHourWeights] = useState<{ hourSlot: number; weight: number }[]>([]);

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
    } catch (e) {}
  };

  const fetchPlatforms = async () => {
    try {
      const res = await api.get('/pt/list');
      if (res.data?.code === 200) {
        const data = res.data.data || [];
        setPlatforms(data.map((p: any) => ({ name: p.pt || p.name, pt: p.pt })));
      }
    } catch (e) {}
  };

  useEffect(() => {
    fetchTasks();
    fetchUsers();
    fetchPlatforms();
  }, []);

  const openCreate = () => {
    form.resetFields();
    setNewPlatformWeights(platforms.map((p) => ({ platform: p.name, weight: 1 })));
    setNewHourWeights(HOUR_SLOTS.map((s) => ({ hourSlot: s.slot, weight: 1 })));
    setModalVisible(true);
  };

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
        platformWeights: newPlatformWeights.filter((w) => w.weight > 0),
        hourWeights: newHourWeights.filter((w) => w.weight > 0),
      });
      if (res.data?.code === 200) {
        message.success('创建成功');
        setModalVisible(false);
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
      message.error('状态更新失败，请检查云端连接');
    }
  };

  const handleCopy = async (id: number) => {
    try {
      const res = await api.post('/task/copy', { taskId: id });
      if (res.data?.code === 200) {
        message.success('复制成功');
        fetchTasks(filterUserId);
      } else {
        message.error(res.data?.message || '复制失败');
      }
    } catch (e) {
      message.error('复制失败');
    }
  };

  // 诊断：获取调度器和任务详细状态
  const fetchDiagnose = async () => {
    setDiagnoseLoading(true);
    try {
      const res = await api.get('/task/diagnose');
      if (res.data?.code === 200) {
        setDiagnoseData(res.data.data);
        setDiagnoseVisible(true);
      } else {
        message.error(res.data?.message || '诊断失败');
      }
    } catch (e) {
      message.error('诊断失败，请检查云端连接');
    } finally {
      setDiagnoseLoading(false);
    }
  };

  // 手动触发单个任务生成
  const handleTrigger = async (id: number) => {
    setTriggering(id);
    try {
      const res = await api.post(`/task/trigger/${id}`);
      if (res.data?.code === 200) {
        const data = res.data?.data;
        message.success('触发成功：' + (data?.result || ''));
        // 显示调试信息
        if (data?.debug) {
          const hw = data.debug.hourWeights || [];
          const hwStr = hw.map((w: any) => `slot${w.hour_slot}=${w.weight}`).join(', ');
          console.log('时区权重配置:', hwStr);
          console.log('生成样本(query_time vs create_time):', data.debug.sample);
          // 用 Modal 显示调试信息
          Modal.info({
            title: '触发结果详情',
            width: 600,
            content: (
              <div style={{ fontSize: 13 }}>
                <p><b>生成结果：</b>{data?.result}</p>
                <p><b>时区权重配置：</b>{hwStr || '无（使用默认分布）'}</p>
                <p><b>最新20条记录（query_time → create_time）：</b></p>
                <div style={{ maxHeight: 300, overflow: 'auto', background: '#f5f5f5', padding: 8, borderRadius: 4 }}>
                  {(data.debug.sample || []).map((s: any, i: number) => (
                    <div key={i}>
                      query_time: <b>{s.queryTime}</b> | create_time: {s.createTime}
                    </div>
                  ))}
                </div>
              </div>
            ),
          });
        }
        fetchTasks(filterUserId);
      } else {
        message.error(res.data?.message || '触发失败');
      }
    } catch (e) {
      message.error('触发失败，请检查云端连接');
    } finally {
      setTriggering(null);
    }
  };

  // 打开编辑弹窗 - 使用 dayjs 转换日期字符串
  const openEdit = (task: TaskItem) => {
    setEditingTask(task);
    editForm.setFieldsValue({
      name: task.name || '',
      count: task.totalNum || 0,
      dateRange: task.startDate && task.endDate ? [dayjs(task.startDate), dayjs(task.endDate)] : undefined,
    });
    const existingPw = task.platformWeights || [];
    setEditPlatformWeights(platforms.map((p) => {
      const found = existingPw.find((w) => w.platform === p.name);
      return { platform: p.name, weight: found?.weight ?? 1 };
    }));
    const existingHw = task.hourWeights || [];
    setEditHourWeights(HOUR_SLOTS.map((s) => {
      const found = existingHw.find((w) => w.hour_slot === s.slot);
      return { hourSlot: s.slot, weight: found?.weight ?? 1 };
    }));
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
        platformWeights: editPlatformWeights.filter((w) => w.weight > 0),
        hourWeights: editHourWeights.filter((w) => w.weight > 0),
      });
      if (res.data?.code === 200) {
        message.success('编辑成功，新配置将应用于未生成的数据');
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
      title: '进度', width: 180,
      render: (_: any, record: TaskItem) => {
        const generated = record.generatedNum || 0;
        const total = record.totalNum || 0;
        const pct = total > 0 ? Math.min(100, Math.round((generated / total) * 100)) : 0;
        return (
          <div>
            <Progress percent={pct} size="small" status={record.status === 'completed' ? 'success' : 'active'} />
            <span style={{ fontSize: 12, color: '#666' }}>{generated} / {total}</span>
          </div>
        );
      },
    },
    {
      title: '权重配置', width: 180,
      render: (_: any, record: TaskItem) => {
        const pw = (record.platformWeights || []).filter((w) => w.weight > 0).length;
        const hw = (record.hourWeights || []).filter((w) => w.weight > 0).length;
        return (
          <Space size={4}>
            <Tag color={pw > 0 ? 'blue' : 'default'}>平台: {pw > 0 ? `${pw}个` : '均匀'}</Tag>
            <Tag color={hw > 0 ? 'cyan' : 'default'}>时区: {hw > 0 ? `${hw}段` : '均匀'}</Tag>
          </Space>
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
          <Button size="small" type="primary" ghost icon={<EditOutlined />} onClick={() => openEdit(record)}>编辑</Button>
          <Button size="small" icon={<ThunderboltOutlined />} loading={triggering === record.id} onClick={() => handleTrigger(record.id)}>触发</Button>
          <Button size="small" icon={<CopyOutlined />} onClick={() => handleCopy(record.id)}>复制</Button>
          <Popconfirm title="确定删除该任务？删除后不可恢复。" okText="确定删除" cancelText="取消" okButtonProps={{ danger: true }} onConfirm={() => handleDelete(record.id)}>
            <Button size="small" danger icon={<DeleteOutlined />}>删除</Button>
          </Popconfirm>
        </Space>
      ),
    },
  ];

  const renderPlatformWeights = (
    weights: { platform: string; weight: number }[],
    setWeights: (w: { platform: string; weight: number }[]) => void
  ) => (
    <div>
      <div style={{ marginBottom: 8, fontSize: 13, color: '#666' }}>
        权重为相对比例。例如平台A权重2、平台B权重3，则数据按 2:3 分配。权重为0表示该平台不生成数据。
      </div>
      <Row gutter={[8, 8]}>
        {weights.map((w, idx) => (
          <Col span={6} key={w.platform}>
            <div className="console-weight-item">
              <div className="console-weight-label">{w.platform}</div>
              <InputNumber
                min={0}
                max={100}
                value={w.weight}
                onChange={(v) => {
                  const nw = [...weights];
                  nw[idx] = { ...nw[idx], weight: v ?? 0 };
                  setWeights(nw);
                }}
                style={{ width: '100%' }}
              />
            </div>
          </Col>
        ))}
      </Row>
    </div>
  );

  const renderHourWeights = (
    weights: { hourSlot: number; weight: number }[],
    setWeights: (w: { hourSlot: number; weight: number }[]) => void
  ) => {
    const total = weights.reduce((s, w) => s + (w.weight || 0), 0);
    return (
      <div>
        <div style={{ marginBottom: 8, fontSize: 13, color: '#666' }}>
          按24小时每3小时一个时段设置权重。权重为相对比例，权重为0表示该时段不生成数据。
        </div>
        <Row gutter={[8, 8]}>
          {weights.map((hw, idx) => {
            const slot = HOUR_SLOTS.find((s) => s.slot === hw.hourSlot);
            const pct = total > 0 && hw.weight > 0 ? Math.round(hw.weight / total * 100) : 0;
            return (
              <Col span={6} key={hw.hourSlot}>
                <div className="console-weight-item">
                  <div style={{ display: 'flex', justifyContent: 'space-between', marginBottom: 4 }}>
                    <span className="console-weight-label" style={{ marginBottom: 0 }}>{slot?.label}</span>
                    {pct > 0 && <Tag color="blue">{pct}%</Tag>}
                  </div>
                  <InputNumber
                    min={0}
                    max={100}
                    value={hw.weight}
                    onChange={(v) => {
                      const nw = [...weights];
                      nw[idx] = { ...nw[idx], weight: v ?? 0 };
                      setWeights(nw);
                    }}
                    style={{ width: '100%' }}
                  />
                </div>
              </Col>
            );
          })}
        </Row>
      </div>
    );
  };

  return (
    <div>
      <div className="console-page-title">
        <span className="console-page-title-text">数据生成任务</span>
        <Space>
          <Select
            style={{ width: 180 }}
            value={filterUserId}
            onChange={(v) => { setFilterUserId(v); fetchTasks(v); }}
            options={[{ value: 'all', label: '全部用户' }, ...users.map((u) => ({ value: String(u.id), label: u.username }))]}
          />
          <Button icon={<ReloadOutlined />} onClick={() => fetchTasks(filterUserId)}>刷新</Button>
          <Button icon={<BugOutlined />} loading={diagnoseLoading} onClick={fetchDiagnose}>诊断</Button>
          <Button type="primary" icon={<PlusOutlined />} onClick={openCreate}>新建任务</Button>
        </Space>
      </div>

      <Table
        loading={loading}
        dataSource={tasks}
        columns={columns}
        rowKey="id"
        scroll={{ x: 1600 }}
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
        width={800}
      >
        <Form form={form} layout="vertical" onFinish={handleCreate}>
          <Row gutter={16}>
            <Col span={12}>
              <Form.Item label="任务名称" name="name">
                <Input placeholder="请输入任务名称（可选）" />
              </Form.Item>
            </Col>
            <Col span={12}>
              <Form.Item label="选择用户" name="userId" rules={[{ required: true, message: '请选择用户' }]}>
                <Select
                  placeholder="请选择用户"
                  options={users.map((u) => ({ value: String(u.id), label: u.username }))}
                />
              </Form.Item>
            </Col>
          </Row>
          <Row gutter={16}>
            <Col span={12}>
              <Form.Item label="生成数量" name="count" rules={[{ required: true, message: '请输入生成数量' }]}>
                <InputNumber min={1} style={{ width: '100%' }} placeholder="请输入生成数量" />
              </Form.Item>
            </Col>
            <Col span={12}>
              <Form.Item
                label="日期范围"
                name="dateRange"
                rules={[{ required: true, message: '请选择日期范围' }]}
                extra="开始时间可设为早于当前日期，系统将按权重自动补齐"
              >
                <RangePicker style={{ width: '100%' }} />
              </Form.Item>
            </Col>
          </Row>

          <Divider style={{ borderColor: '#1677ff', color: '#1677ff', fontWeight: 600 }}>平台权重</Divider>
          {renderPlatformWeights(newPlatformWeights, setNewPlatformWeights)}

          <Divider style={{ borderColor: '#1677ff', color: '#1677ff', fontWeight: 600 }}>时区权重</Divider>
          {renderHourWeights(newHourWeights, setNewHourWeights)}
        </Form>
      </Modal>

      {/* 编辑任务弹窗 */}
      <Modal
        title={`编辑任务 - ${editingTask?.name || editingTask?.id || ''}`}
        open={editModalVisible}
        onCancel={() => setEditModalVisible(false)}
        onOk={() => editForm.submit()}
        confirmLoading={submitting}
        destroyOnClose
        width={800}
      >
        <div className="console-tip console-tip-warning">
          调整后的设置不会影响已生成的数据，但会影响还未生成的数据。系统会根据新的权重配置生成后续数据。
          若开始时间早于当前，系统会按权重自动补齐从开始时间到当前的数据。
        </div>
        <Form form={editForm} layout="vertical" onFinish={handleEdit}>
          <Row gutter={16}>
            <Col span={12}>
              <Form.Item label="任务名称" name="name">
                <Input placeholder="请输入任务名称（可选）" />
              </Form.Item>
            </Col>
            <Col span={12}>
              <Form.Item label="生成总数" name="count" rules={[{ required: true, message: '请输入生成数量' }]} extra="可修改生成总数，调整后影响未生成的数据">
                <InputNumber min={1} style={{ width: '100%' }} placeholder="请输入生成总数" />
              </Form.Item>
            </Col>
          </Row>
          <Form.Item
            label="日期范围"
            name="dateRange"
            rules={[{ required: true, message: '请选择日期范围' }]}
            extra="可往更早的日期设置，系统会按权重配置自动补充数据"
          >
            <RangePicker style={{ width: '100%' }} />
          </Form.Item>

          <Divider style={{ borderColor: '#1677ff', color: '#1677ff', fontWeight: 600 }}>平台权重</Divider>
          {renderPlatformWeights(editPlatformWeights, setEditPlatformWeights)}

          <Divider style={{ borderColor: '#1677ff', color: '#1677ff', fontWeight: 600 }}>时区权重</Divider>
          {renderHourWeights(editHourWeights, setEditHourWeights)}
        </Form>
      </Modal>

      {/* 诊断弹窗 */}
      <Modal
        title="任务诊断"
        open={diagnoseVisible}
        onCancel={() => setDiagnoseVisible(false)}
        footer={[<Button key="close" onClick={() => setDiagnoseVisible(false)}>关闭</Button>]}
        width={900}
      >
        {diagnoseData && (
          <div>
            <div className="console-tip console-tip-info" style={{ marginBottom: 16 }}>
              <div><strong>调度器状态</strong></div>
              <div>时区: {diagnoseData.scheduler.timezone}</div>
              <div>启动时间: {diagnoseData.scheduler.startedAt}</div>
              <div>当前服务器时间: {diagnoseData.scheduler.currentTime}</div>
              <div>最后运行时间: {diagnoseData.scheduler.lastRunTime || '从未运行'}</div>
              <div>总运行次数: {diagnoseData.scheduler.totalRuns}</div>
              <div>最后结果: {diagnoseData.scheduler.lastRunResult || '无'}</div>
            </div>

            <Divider>任务详情</Divider>

            {diagnoseData.tasks.map((task: any) => (
              <div key={task.id} style={{ marginBottom: 16, padding: 12, border: '1px solid #e8e8e8', borderRadius: 8 }}>
                <div style={{ fontWeight: 600, marginBottom: 8 }}>
                  任务 #{task.id} - {task.name || '未命名'} ({task.userName || task.userId})
                  <Tag color={task.status === 'running' ? 'processing' : 'default'} style={{ marginLeft: 8 }}>
                    {task.status}
                  </Tag>
                  {task.isExpired && <Tag color="error" style={{ marginLeft: 4 }}>已过期</Tag>}
                </div>
                <Row gutter={16}>
                  <Col span={6}>
                    <div style={{ fontSize: 12, color: '#666' }}>日期范围</div>
                    <div>{task.startDate} ~ {task.endDate}</div>
                  </Col>
                  <Col span={6}>
                    <div style={{ fontSize: 12, color: '#666' }}>生成总数</div>
                    <div>{task.totalNum}</div>
                  </Col>
                  <Col span={6}>
                    <div style={{ fontSize: 12, color: '#666' }}>已生成</div>
                    <div>{task.generatedNum}</div>
                  </Col>
                  <Col span={6}>
                    <div style={{ fontSize: 12, color: '#666' }}>进度</div>
                    <div>{task.daysElapsed}/{task.totalDays} 天</div>
                  </Col>
                </Row>
                <Row gutter={16} style={{ marginTop: 8 }}>
                  <Col span={6}>
                    <div style={{ fontSize: 12, color: '#666' }}>蒸馏关键词库</div>
                    <div>{task.zlgjcCount} 条 {task.zlgjcCount === 0 && <span style={{ color: '#ff4d4f' }}>(空，无法生成)</span>}</div>
                  </Col>
                  <Col span={6}>
                    <div style={{ fontSize: 12, color: '#666' }}>品牌关键词库</div>
                    <div>{task.brandZlgjcCount} 条</div>
                  </Col>
                  <Col span={6}>
                    <div style={{ fontSize: 12, color: '#666' }}>平台权重</div>
                    <div>{task.platformWeights.length} 个平台</div>
                  </Col>
                  <Col span={6}>
                    <div style={{ fontSize: 12, color: '#666' }}>最新记录</div>
                    <div>{task.latestRecord ? task.latestRecord.create_time : '无'}</div>
                  </Col>
                </Row>
                {task.dailyRandomRecords && task.dailyRandomRecords.length > 0 && (
                  <div style={{ marginTop: 8 }}>
                    <div style={{ fontSize: 12, color: '#666' }}>daily_random 记录（最近5条）:</div>
                    {task.dailyRandomRecords.map((dr: any, i: number) => (
                      <Tag key={i} style={{ marginTop: 4 }}>{dr.random_date}: {dr.random_num}条</Tag>
                    ))}
                  </div>
                )}
                {task.platformWeights.length === 0 && (
                  <div style={{ marginTop: 8, color: '#ff4d4f', fontSize: 12 }}>
                    ⚠ 没有配置平台权重，调度器会跳过此任务
                  </div>
                )}
                {task.zlgjcCount === 0 && (
                  <div style={{ marginTop: 8, color: '#ff4d4f', fontSize: 12 }}>
                    ⚠ 没有蒸馏关键词库，调度器会跳过此任务
                  </div>
                )}
                {task.isExpired && (
                  <div style={{ marginTop: 8, color: '#ff4d4f', fontSize: 12 }}>
                    ⚠ 任务已过期（end_date 早于今天），调度器会标记为 completed
                  </div>
                )}
              </div>
            ))}
          </div>
        )}
      </Modal>
    </div>
  );
}
