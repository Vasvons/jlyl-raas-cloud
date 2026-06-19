'use client';

import React, { useState, useEffect } from 'react';
import { Card, Row, Col, Statistic, Table, Tag, Progress, message, Button, Space, Input, InputNumber, Modal, Form, Tabs } from 'antd';
import { ReloadOutlined, UserOutlined, DatabaseOutlined, RiseOutlined, FileTextOutlined, ThunderboltOutlined } from '@ant-design/icons';
import api from '@/lib/api';

interface SystemOverview {
  totalUsers: number;
  totalTasks: number;
  runningTasks: number;
  totalRecords: number;
  totalKeywords: number;
  todayRecords: number;
}

interface TaskStatusItem {
  status: string;
  count: number;
}

interface RecentRecord {
  id: number;
  expandedKeyword: string;
  distillateKeyword: string;
  platform: string;
  userId: string;
  queryTime: string;
  createTime: string;
}

interface UserStat {
  userId: number;
  username: string;
  taskCount: number;
  coreKeywordCount: number;
  zlgjcCount: number;
  recordCount: number;
}

const STATUS_MAP: Record<string, { color: string; text: string }> = {
  running: { color: 'processing', text: '运行中' },
  paused: { color: 'warning', text: '已暂停' },
  completed: { color: 'success', text: '已完成' },
  failed: { color: 'error', text: '失败' },
  pending: { color: 'default', text: '等待中' },
};

export default function MonitorPage() {
  const [loading, setLoading] = useState(false);
  const [overview, setOverview] = useState<SystemOverview | null>(null);
  const [taskSummary, setTaskSummary] = useState<TaskStatusItem[]>([]);
  const [recentRecords, setRecentRecords] = useState<RecentRecord[]>([]);
  const [userStats, setUserStats] = useState<UserStat[]>([]);
  const [recentLimit, setRecentLimit] = useState(50);
  const [activeTab, setActiveTab] = useState('overview');

  const fetchAll = async () => {
    setLoading(true);
    try {
      const [overviewRes, taskRes, recentRes, userStatsRes] = await Promise.all([
        api.get('/monitor/overview').catch(() => ({ data: { code: 500 } })),
        api.get('/monitor/taskSummary').catch(() => ({ data: { code: 500 } })),
        api.get('/monitor/recent', { params: { limit: recentLimit } }).catch(() => ({ data: { code: 500 } })),
        api.get('/monitor/userStats').catch(() => ({ data: { code: 500 } })),
      ]);

      if (overviewRes.data?.code === 200) setOverview(overviewRes.data.data);
      if (taskRes.data?.code === 200) setTaskSummary(taskRes.data.data || []);
      if (recentRes.data?.code === 200) setRecentRecords(recentRes.data.data || []);
      if (userStatsRes.data?.code === 200) setUserStats(userStatsRes.data.data || []);
    } catch (e) {
      message.error('获取监测数据失败');
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => {
    fetchAll();
    // 每30秒自动刷新
    const timer = setInterval(fetchAll, 30000);
    return () => clearInterval(timer);
  }, [recentLimit]);

  const recentColumns = [
    { title: 'ID', dataIndex: 'id', width: 80 },
    { title: '蒸馏关键词', dataIndex: 'distillateKeyword', width: 150 },
    { title: '扩展关键词', dataIndex: 'expandedKeyword', width: 200 },
    {
      title: '平台', dataIndex: 'platform', width: 120,
      render: (v: string) => v ? <Tag color="blue">{v}</Tag> : '-',
    },
    { title: '用户ID', dataIndex: 'userId', width: 100 },
    { title: '查询时间', dataIndex: 'queryTime', width: 180 },
    { title: '生成时间', dataIndex: 'createTime', width: 180 },
  ];

  const userStatColumns = [
    { title: '用户ID', dataIndex: 'userId', width: 80 },
    { title: '用户名', dataIndex: 'username', width: 150 },
    {
      title: '任务数', dataIndex: 'taskCount', width: 100,
      sorter: (a: UserStat, b: UserStat) => a.taskCount - b.taskCount,
    },
    {
      title: '核心关键词数', dataIndex: 'coreKeywordCount', width: 120,
      sorter: (a: UserStat, b: UserStat) => a.coreKeywordCount - b.coreKeywordCount,
    },
    {
      title: '蒸馏关键词数', dataIndex: 'zlgjcCount', width: 120,
      sorter: (a: UserStat, b: UserStat) => a.zlgjcCount - b.zlgjcCount,
    },
    {
      title: '数据记录数', dataIndex: 'recordCount', width: 120,
      sorter: (a: UserStat, b: UserStat) => a.recordCount - b.recordCount,
      render: (v: number) => <Tag color={v > 0 ? 'green' : 'default'}>{v}</Tag>,
    },
  ];

  return (
    <div>
      <div style={{ display: 'flex', justifyContent: 'space-between', marginBottom: 16 }}>
        <h2 style={{ margin: 0 }}>数据监测</h2>
        <Space>
          <span>显示最近</span>
          <InputNumber
            min={10}
            max={100}
            value={recentLimit}
            onChange={(v) => setRecentLimit(v || 50)}
            style={{ width: 80 }}
          />
          <span>条记录</span>
          <Button type="primary" icon={<ReloadOutlined />} onClick={fetchAll} loading={loading}>
            刷新
          </Button>
        </Space>
      </div>

      <Tabs
        activeKey={activeTab}
        onChange={setActiveTab}
        items={[
          {
            key: 'overview',
            label: '系统概览',
            children: (
              <div>
                <Row gutter={[16, 16]}>
                  <Col span={6}>
                    <Card>
                      <Statistic
                        title="用户总数"
                        value={overview?.totalUsers || 0}
                        prefix={<UserOutlined />}
                        loading={loading}
                      />
                    </Card>
                  </Col>
                  <Col span={6}>
                    <Card>
                      <Statistic
                        title="任务总数"
                        value={overview?.totalTasks || 0}
                        prefix={<ThunderboltOutlined />}
                        suffix={` (运行中 ${overview?.runningTasks || 0})`}
                        loading={loading}
                      />
                    </Card>
                  </Col>
                  <Col span={6}>
                    <Card>
                      <Statistic
                        title="数据记录总数"
                        value={overview?.totalRecords || 0}
                        prefix={<DatabaseOutlined />}
                        loading={loading}
                      />
                    </Card>
                  </Col>
                  <Col span={6}>
                    <Card>
                      <Statistic
                        title="今日新增记录"
                        value={overview?.todayRecords || 0}
                        prefix={<RiseOutlined />}
                        valueStyle={{ color: '#cf1322' }}
                        loading={loading}
                      />
                    </Card>
                  </Col>
                </Row>

                <Row gutter={[16, 16]} style={{ marginTop: 16 }}>
                  <Col span={6}>
                    <Card>
                      <Statistic
                        title="关键词总数"
                        value={overview?.totalKeywords || 0}
                        prefix={<FileTextOutlined />}
                        loading={loading}
                      />
                    </Card>
                  </Col>
                  <Col span={18}>
                    <Card title="任务状态分布" size="small">
                      {taskSummary.length === 0 ? (
                        <div style={{ textAlign: 'center', color: '#999', padding: 24 }}>暂无任务数据</div>
                      ) : (
                        <Row gutter={[16, 16]}>
                          {taskSummary.map((item) => {
                            const cfg = STATUS_MAP[item.status] || { color: 'default', text: item.status };
                            const total = taskSummary.reduce((sum, i) => sum + i.count, 0);
                            const pct = total > 0 ? Math.round((item.count / total) * 100) : 0;
                            return (
                              <Col span={8} key={item.status}>
                                <div style={{ marginBottom: 8 }}>
                                  <Tag color={cfg.color}>{cfg.text}</Tag>
                                  <span style={{ marginLeft: 8, fontWeight: 600 }}>{item.count} 个</span>
                                </div>
                                <Progress percent={pct} size="small" status={item.status === 'running' ? 'active' : 'normal'} />
                              </Col>
                            );
                          })}
                        </Row>
                      )}
                    </Card>
                  </Col>
                </Row>
              </div>
            ),
          },
          {
            key: 'recent',
            label: '最近生成记录',
            children: (
              <Table
                loading={loading}
                dataSource={recentRecords}
                columns={recentColumns}
                rowKey="id"
                pagination={{ pageSize: 20, showSizeChanger: true, showTotal: (t) => `共 ${t} 条` }}
                size="small"
                scroll={{ x: 1000 }}
              />
            ),
          },
          {
            key: 'userStats',
            label: '用户数据统计',
            children: (
              <Table
                loading={loading}
                dataSource={userStats}
                columns={userStatColumns}
                rowKey="userId"
                pagination={false}
                size="small"
              />
            ),
          },
        ]}
      />
    </div>
  );
}
