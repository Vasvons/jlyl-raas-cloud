'use client';

import React, { useState, useEffect } from 'react';
import { Card, Row, Col, Statistic, Table, Tag, Progress, message, Button, Space, InputNumber, Tabs, Modal, Descriptions, Empty, Spin } from 'antd';
import { ReloadOutlined, UserOutlined, DatabaseOutlined, RiseOutlined, FileTextOutlined, ThunderboltOutlined, EyeOutlined, FileSearchOutlined, ContactsOutlined, CalendarOutlined } from '@ant-design/icons';
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

interface UserDetail {
  user: {
    id: number;
    username: string;
    phone: string;
    email: string;
    url: string;
    dateTime: string;
  };
  summary: {
    taskCount: number;
    coreKeywordCount: number;
    zlgjcCount: number;
    ppCount: number;
    recordCount: number;
    todayRecords: number;
    lxfsCount: number;
  };
  tasks: {
    id: number;
    name: string;
    startDate: string;
    endDate: string;
    totalNum: number;
    status: string;
    createTime: string;
    generatedNum: number;
  }[];
  platformDistribution: { platform: string; count: number }[];
  dailyTrend: { date: string; count: number }[];
}

const STATUS_MAP: Record<string, { color: string; text: string }> = {
  running: { color: 'processing', text: '运行中' },
  paused: { color: 'warning', text: '已暂停' },
  completed: { color: 'success', text: '已完成' },
  failed: { color: 'error', text: '失败' },
  pending: { color: 'default', text: '等待中' },
};

// 颜色调色板（用于平台分布）
const PLATFORM_COLORS = ['#1890ff', '#52c41a', '#faad14', '#f5222d', '#722ed1', '#13c2c2', '#eb2f96', '#fa8c16', '#a0d911', '#2f54eb'];

export default function MonitorPage() {
  const [loading, setLoading] = useState(false);
  const [overview, setOverview] = useState<SystemOverview | null>(null);
  const [taskSummary, setTaskSummary] = useState<TaskStatusItem[]>([]);
  const [recentRecords, setRecentRecords] = useState<RecentRecord[]>([]);
  const [userStats, setUserStats] = useState<UserStat[]>([]);
  const [recentLimit, setRecentLimit] = useState(50);
  const [activeTab, setActiveTab] = useState('overview');

  // 用户详情
  const [detailModalVisible, setDetailModalVisible] = useState(false);
  const [detailLoading, setDetailLoading] = useState(false);
  const [userDetail, setUserDetail] = useState<UserDetail | null>(null);

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
    const timer = setInterval(fetchAll, 30000);
    return () => clearInterval(timer);
  }, [recentLimit]);

  // 查看用户详情
  const fetchUserDetail = async (userId: number) => {
    setDetailModalVisible(true);
    setDetailLoading(true);
    setUserDetail(null);
    try {
      const res = await api.get('/monitor/userDetail', { params: { userId } });
      if (res.data?.code === 200) {
        setUserDetail(res.data.data);
      } else {
        message.error(res.data?.message || '获取用户详情失败');
      }
    } catch (e) {
      message.error('获取用户详情失败');
    } finally {
      setDetailLoading(false);
    }
  };

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
    { title: '用户名', dataIndex: 'username', width: 120 },
    {
      title: '任务数', dataIndex: 'taskCount', width: 90,
      sorter: (a: UserStat, b: UserStat) => a.taskCount - b.taskCount,
      render: (v: number) => <Tag color={v > 0 ? 'blue' : 'default'}>{v}</Tag>,
    },
    {
      title: '核心关键词', dataIndex: 'coreKeywordCount', width: 110,
      sorter: (a: UserStat, b: UserStat) => a.coreKeywordCount - b.coreKeywordCount,
    },
    {
      title: '蒸馏关键词', dataIndex: 'zlgjcCount', width: 110,
      sorter: (a: UserStat, b: UserStat) => a.zlgjcCount - b.zlgjcCount,
    },
    {
      title: '数据记录数', dataIndex: 'recordCount', width: 110,
      sorter: (a: UserStat, b: UserStat) => a.recordCount - b.recordCount,
      render: (v: number) => <Tag color={v > 0 ? 'green' : 'default'}>{v}</Tag>,
    },
    {
      title: '操作', width: 100,
      render: (_: any, record: UserStat) => (
        <Button size="small" type="primary" ghost icon={<EyeOutlined />} onClick={() => fetchUserDetail(record.userId)}>
          详情
        </Button>
      ),
    },
  ];

  // 渲染用户详情弹窗
  const renderUserDetail = () => {
    const maxPlatformCount = userDetail ? Math.max(...userDetail.platformDistribution.map((p) => p.count), 1) : 1;
    const maxTrendCount = userDetail ? Math.max(...userDetail.dailyTrend.map((d) => d.count), 1) : 1;

    return (
      <Modal
        title={userDetail ? `用户详情 - ${userDetail.user.username}` : '用户详情'}
        open={detailModalVisible}
        onCancel={() => setDetailModalVisible(false)}
        footer={<Button onClick={() => setDetailModalVisible(false)}>关闭</Button>}
        width={900}
      >
        {detailLoading ? (
          <div style={{ textAlign: 'center', padding: 60 }}><Spin size="large" /></div>
        ) : !userDetail ? (
          <Empty description="暂无数据" />
        ) : (
          <div>
            {/* 用户基本信息 */}
            <Descriptions title="基本信息" bordered size="small" column={2} style={{ marginBottom: 16 }}>
              <Descriptions.Item label="用户名">{userDetail.user.username}</Descriptions.Item>
              <Descriptions.Item label="用户ID">{userDetail.user.id}</Descriptions.Item>
              <Descriptions.Item label="电话">{userDetail.user.phone || '-'}</Descriptions.Item>
              <Descriptions.Item label="邮箱">{userDetail.user.email || '-'}</Descriptions.Item>
              <Descriptions.Item label="网址" span={2}>{userDetail.user.url || '-'}</Descriptions.Item>
              <Descriptions.Item label="注册时间" span={2}>{userDetail.user.dateTime || '-'}</Descriptions.Item>
            </Descriptions>

            {/* 数据概览 */}
            <Row gutter={[12, 12]} style={{ marginBottom: 16 }}>
              <Col span={6}>
                <Card size="small">
                  <Statistic title="任务数" value={userDetail.summary.taskCount} prefix={<ThunderboltOutlined />} />
                </Card>
              </Col>
              <Col span={6}>
                <Card size="small">
                  <Statistic title="数据记录" value={userDetail.summary.recordCount} prefix={<DatabaseOutlined />} />
                </Card>
              </Col>
              <Col span={6}>
                <Card size="small">
                  <Statistic title="今日新增" value={userDetail.summary.todayRecords} prefix={<RiseOutlined />} valueStyle={{ color: '#cf1322' }} />
                </Card>
              </Col>
              <Col span={6}>
                <Card size="small">
                  <Statistic title="联系方式标记" value={userDetail.summary.lxfsCount} prefix={<ContactsOutlined />} valueStyle={{ color: '#52c41a' }} />
                </Card>
              </Col>
              <Col span={8}>
                <Card size="small">
                  <Statistic title="核心关键词" value={userDetail.summary.coreKeywordCount} prefix={<FileTextOutlined />} />
                </Card>
              </Col>
              <Col span={8}>
                <Card size="small">
                  <Statistic title="蒸馏关键词" value={userDetail.summary.zlgjcCount} prefix={<FileSearchOutlined />} />
                </Card>
              </Col>
              <Col span={8}>
                <Card size="small">
                  <Statistic title="品牌词" value={userDetail.summary.ppCount} prefix={<FileTextOutlined />} />
                </Card>
              </Col>
            </Row>

            {/* 平台数据分布 */}
            <Card title="平台数据分布" size="small" style={{ marginBottom: 16 }}>
              {userDetail.platformDistribution.length === 0 ? (
                <Empty description="暂无数据" image={Empty.PRESENTED_IMAGE_SIMPLE} />
              ) : (
                userDetail.platformDistribution.map((p, idx) => {
                  const pct = Math.round((p.count / maxPlatformCount) * 100);
                  const color = PLATFORM_COLORS[idx % PLATFORM_COLORS.length];
                  return (
                    <div key={p.platform} style={{ marginBottom: 8 }}>
                      <div style={{ display: 'flex', justifyContent: 'space-between', marginBottom: 4 }}>
                        <span style={{ fontSize: 13 }}>
                          <Tag color={color}>{p.platform}</Tag>
                        </span>
                        <span style={{ fontSize: 13, fontWeight: 600 }}>{p.count} 条</span>
                      </div>
                      <Progress percent={pct} size="small" strokeColor={color} showInfo={false} />
                    </div>
                  );
                })
              )}
            </Card>

            {/* 最近7天趋势 */}
            <Card title="最近7天生成趋势" size="small" style={{ marginBottom: 16 }}>
              {userDetail.dailyTrend.length === 0 ? (
                <Empty description="暂无数据" image={Empty.PRESENTED_IMAGE_SIMPLE} />
              ) : (
                <Row gutter={[8, 8]}>
                  {userDetail.dailyTrend.map((d) => {
                    const pct = Math.round((d.count / maxTrendCount) * 100);
                    return (
                      <Col span={Math.floor(24 / Math.max(userDetail.dailyTrend.length, 1))} key={d.date}>
                        <div style={{ textAlign: 'center' }}>
                          <div style={{ fontSize: 12, color: '#999', marginBottom: 4 }}>
                            {String(d.date).slice(5)}
                          </div>
                          <div style={{ fontSize: 18, fontWeight: 600, color: '#1890ff' }}>{d.count}</div>
                          <Progress percent={pct} size="small" showInfo={false} />
                        </div>
                      </Col>
                    );
                  })}
                </Row>
              )}
            </Card>

            {/* 任务列表 */}
            <Card title="任务列表" size="small">
              {userDetail.tasks.length === 0 ? (
                <Empty description="暂无任务" image={Empty.PRESENTED_IMAGE_SIMPLE} />
              ) : (
                <Table
                  dataSource={userDetail.tasks}
                  rowKey="id"
                  size="small"
                  pagination={{ pageSize: 5 }}
                  columns={[
                    { title: 'ID', dataIndex: 'id', width: 80 },
                    { title: '任务名', dataIndex: 'name', width: 120, render: (v: string) => v || '-' },
                    { title: '开始', dataIndex: 'startDate', width: 110 },
                    { title: '结束', dataIndex: 'endDate', width: 110 },
                    {
                      title: '进度', width: 150,
                      render: (_: any, record: any) => {
                        const pct = record.totalNum > 0 ? Math.min(100, Math.round((record.generatedNum / record.totalNum) * 100)) : 0;
                        return (
                          <div>
                            <Progress percent={pct} size="small" status={record.status === 'completed' ? 'success' : 'active'} />
                            <span style={{ fontSize: 11, color: '#999' }}>{record.generatedNum}/{record.totalNum}</span>
                          </div>
                        );
                      },
                    },
                    {
                      title: '状态', dataIndex: 'status', width: 90,
                      render: (v: string) => {
                        const cfg = STATUS_MAP[v] || { color: 'default', text: v };
                        return <Tag color={cfg.color}>{cfg.text}</Tag>;
                      },
                    },
                  ]}
                />
              )}
            </Card>
          </div>
        )}
      </Modal>
    );
  };

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
                    <Card hoverable>
                      <Statistic
                        title="客户总数"
                        value={overview?.totalUsers || 0}
                        prefix={<UserOutlined />}
                        loading={loading}
                        valueStyle={{ color: '#1890ff' }}
                      />
                    </Card>
                  </Col>
                  <Col span={6}>
                    <Card hoverable>
                      <Statistic
                        title="任务总数"
                        value={overview?.totalTasks || 0}
                        prefix={<ThunderboltOutlined />}
                        suffix={<span style={{ fontSize: 14, color: '#52c41a' }}> (运行中 {overview?.runningTasks || 0})</span>}
                        loading={loading}
                        valueStyle={{ color: '#722ed1' }}
                      />
                    </Card>
                  </Col>
                  <Col span={6}>
                    <Card hoverable>
                      <Statistic
                        title="数据记录总数"
                        value={overview?.totalRecords || 0}
                        prefix={<DatabaseOutlined />}
                        loading={loading}
                        valueStyle={{ color: '#13c2c2' }}
                      />
                    </Card>
                  </Col>
                  <Col span={6}>
                    <Card hoverable>
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
                  <Col span={8}>
                    <Card hoverable>
                      <Statistic
                        title="关键词总数"
                        value={overview?.totalKeywords || 0}
                        prefix={<FileTextOutlined />}
                        loading={loading}
                        valueStyle={{ color: '#fa8c16' }}
                      />
                      <div style={{ marginTop: 8, fontSize: 12, color: '#999' }}>核心关键词 + 蒸馏关键词</div>
                    </Card>
                  </Col>
                  <Col span={16}>
                    <Card title="任务状态分布" size="small">
                      {taskSummary.length === 0 ? (
                        <Empty description="暂无任务数据" image={Empty.PRESENTED_IMAGE_SIMPLE} />
                      ) : (
                        <Row gutter={[16, 16]}>
                          {taskSummary.map((item) => {
                            const cfg = STATUS_MAP[item.status] || { color: 'default', text: item.status };
                            const total = taskSummary.reduce((sum, i) => sum + i.count, 0);
                            const pct = total > 0 ? Math.round((item.count / total) * 100) : 0;
                            return (
                              <Col span={Math.floor(24 / taskSummary.length)} key={item.status}>
                                <div style={{ marginBottom: 8 }}>
                                  <Tag color={cfg.color} style={{ fontSize: 14, padding: '2px 12px' }}>{cfg.text}</Tag>
                                  <span style={{ marginLeft: 8, fontWeight: 600, fontSize: 16 }}>{item.count}</span>
                                  <span style={{ marginLeft: 4, color: '#999' }}>个</span>
                                </div>
                                <Progress percent={pct} status={item.status === 'running' ? 'active' : 'normal'} />
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

      {renderUserDetail()}
    </div>
  );
}
