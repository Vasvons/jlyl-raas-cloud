'use client';

import React, { useState, useEffect } from 'react';
import { Card, Table, Tag, Spin, Pagination, Radio, Select, Row, Col, message, Button } from 'antd';
import ReactECharts from 'echarts-for-react';
import api from '@/lib/api';
import { useRouter } from 'next/navigation';

const IMG = 'https://static.7asi.com/assets/reportGeo';

interface LoginUser {
  id: string;
  username: string;
  phone: string;
  email: string;
  url: string;
  dateTime: string;
}

interface PlatformRatioItem {
  pt: string;
  count: number;
}

interface SearchRankItem {
  id: number;
  expandedKeyword: string;
  distillateKeyword: string;
  platform: string;
  queryTime: string;
  url: string;
  zlgjcUrl?: string;
}

export default function DashboardPage() {
  const router = useRouter();
  const [user, setUser] = useState<LoginUser | null>(null);
  const [loading, setLoading] = useState(true);

  // 统计数据
  const [keywordCount, setKeywordCount] = useState({ coreCount: 0, distillateCount: 0, totalCount: 0 });
  const [platformRatio, setPlatformRatio] = useState<PlatformRatioItem[]>([]);

  // 搜索排名
  const [searchType, setSearchType] = useState<string>('keywords');
  const [platform, setPlatform] = useState<string>('全部');
  const [platforms, setPlatforms] = useState<any[]>([]);
  const [searchKeyword, setSearchKeyword] = useState('');
  const [rankList, setRankList] = useState<SearchRankItem[]>([]);
  const [rankTotal, setRankTotal] = useState(0);
  const [rankPage, setRankPage] = useState(1);
  const [rankLoading, setRankLoading] = useState(false);

  // 初始化：检查登录
  useEffect(() => {
    const userInfo = localStorage.getItem('userInfo');
    const token = localStorage.getItem('token');
    if (!token || !userInfo) {
      router.push('/login');
      return;
    }
    setUser(JSON.parse(userInfo));
  }, [router]);

  // 加载平台列表
  useEffect(() => {
    if (!user) return;
    (async () => {
      try {
        const res = await api.get('/dashboard/platforms');
        if (res.data?.code === 200) {
          setPlatforms([{ id: 0, pt: '全部' }, ...res.data.data]);
        }
      } catch {}
    })();
  }, [user]);

  // 加载统计数据
  useEffect(() => {
    if (!user) return;
    (async () => {
      setLoading(true);
      try {
        const [countRes, ratioRes] = await Promise.all([
          api.get('/dashboard/keywordCount', { params: { userId: user.id } }),
          api.get('/dashboard/platformRatio', { params: { userId: user.id } }),
        ]);
        if (countRes.data?.code === 200) setKeywordCount(countRes.data.data);
        if (ratioRes.data?.code === 200) setPlatformRatio(ratioRes.data.data);
      } finally {
        setLoading(false);
      }
    })();
  }, [user]);

  // 加载搜索排名
  useEffect(() => {
    if (!user) return;
    fetchRankList();
  }, [user, searchType, platform, rankPage]);

  const fetchRankList = async () => {
    if (!user) return;
    setRankLoading(true);
    try {
      const res = await api.get('/dashboard/keypage', {
        params: {
          userId: user.id,
          platform: platform === '全部' ? undefined : platform,
          keyword: searchKeyword || undefined,
          type: searchType,
          page: rankPage,
          pageSize: 20,
        },
      });
      if (res.data?.code === 200) {
        setRankList(res.data.data.list);
        setRankTotal(res.data.data.total);
      }
    } finally {
      setRankLoading(false);
    }
  };

  const onSearch = () => {
    setRankPage(1);
    fetchRankList();
  };

  const onLogout = () => {
    localStorage.removeItem('token');
    localStorage.removeItem('userInfo');
    router.push('/login');
  };

  if (!user) {
    return <div style={{ textAlign: 'center', padding: 100 }}><Spin size="large" /></div>;
  }

  // 平台占比饼图
  const pieOption = {
    tooltip: { trigger: 'item', formatter: '{b}: {c} ({d}%)' },
    legend: { orient: 'vertical', left: 'left' },
    series: [{
      type: 'pie',
      radius: ['40%', '70%'],
      data: platformRatio.map(p => ({ name: p.pt, value: p.count })),
      emphasis: { itemStyle: { shadowBlur: 10, shadowOffsetX: 0, shadowColor: 'rgba(0, 0, 0, 0.5)' } },
    }],
  };

  const columns = [
    { title: '蒸馏关键词', dataIndex: 'distillateKeyword', key: 'distillateKeyword', ellipsis: true },
    { title: '核心关键词', dataIndex: 'expandedKeyword', key: 'expandedKeyword', ellipsis: true },
    { title: '平台', dataIndex: 'platform', key: 'platform', width: 100 },
    { title: '查询时间', dataIndex: 'queryTime', key: 'queryTime', width: 180 },
    {
      title: '操作',
      key: 'action',
      width: 100,
      render: (_: any, record: SearchRankItem) => (
        record.zlgjcUrl ? (
          <a href={record.zlgjcUrl} target="_blank" rel="noopener noreferrer">查看详情</a>
        ) : <span style={{ color: '#999' }}>未配置</span>
      ),
    },
  ];

  return (
    <div style={{ padding: 24, background: '#f0f2f5', minHeight: '100vh' }}>
      {/* 顶部栏 */}
      <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: 24 }}>
        <h2 style={{ margin: 0 }}>GEO 报告</h2>
        <div>
          <span style={{ marginRight: 16 }}>最后更新：{user.dateTime || '-'}</span>
          <Button onClick={onLogout}>退出登录</Button>
        </div>
      </div>

      {loading ? (
        <div style={{ textAlign: 'center', padding: 100 }}><Spin size="large" /></div>
      ) : (
        <>
          {/* AI 名片 */}
          <Card style={{ marginBottom: 24, background: 'linear-gradient(135deg, #667eea 0%, #764ba2 100%)' }}>
            <Row align="middle">
              <Col span={6}>
                <div style={{ textAlign: 'center' }}>
                  <img src={`${IMG}/256x256.png`} alt="" style={{ width: 80, height: 80 }} />
                  <div style={{ color: '#fff', marginTop: 8, fontWeight: 600, fontSize: 18 }}>{user.username}</div>
                  <div style={{ color: 'rgba(255,255,255,0.8)' }}>AI 名片</div>
                </div>
              </Col>
              <Col span={18}>
                <Row gutter={[16, 16]}>
                  <Col span={8}>
                    <div style={{ color: 'rgba(255,255,255,0.7)' }}>电话</div>
                    <div style={{ color: '#fff' }}>{user.phone || '-'}</div>
                  </Col>
                  <Col span={8}>
                    <div style={{ color: 'rgba(255,255,255,0.7)' }}>邮箱</div>
                    <div style={{ color: '#fff' }}>{user.email || '-'}</div>
                  </Col>
                  <Col span={8}>
                    <div style={{ color: 'rgba(255,255,255,0.7)' }}>网址</div>
                    <div style={{ color: '#fff' }}>{user.url || '-'}</div>
                  </Col>
                </Row>
              </Col>
            </Row>
          </Card>

          {/* 统计卡片 */}
          <Row gutter={16} style={{ marginBottom: 24 }}>
            <Col span={8}>
              <Card>
                <div style={{ fontSize: 14, color: '#666' }}>核心关键词</div>
                <div style={{ fontSize: 28, fontWeight: 600, color: '#1890ff' }}>{keywordCount.coreCount}</div>
              </Card>
            </Col>
            <Col span={8}>
              <Card>
                <div style={{ fontSize: 14, color: '#666' }}>蒸馏关键词</div>
                <div style={{ fontSize: 28, fontWeight: 600, color: '#52c41a' }}>{keywordCount.distillateCount}</div>
              </Card>
            </Col>
            <Col span={8}>
              <Card>
                <div style={{ fontSize: 14, color: '#666' }}>总收录</div>
                <div style={{ fontSize: 28, fontWeight: 600, color: '#faad14' }}>{keywordCount.totalCount}</div>
              </Card>
            </Col>
          </Row>

          {/* 平台占比 */}
          <Card title="各平台收录对比" style={{ marginBottom: 24 }}>
            <ReactECharts option={pieOption} style={{ height: 300 }} />
          </Card>

          {/* 搜索排名 */}
          <Card title="搜索排名">
            <div style={{ marginBottom: 16, display: 'flex', gap: 16, flexWrap: 'wrap' }}>
              <Radio.Group value={searchType} onChange={(e) => { setSearchType(e.target.value); setRankPage(1); }}>
                <Radio.Button value="keywords">关键词搜索</Radio.Button>
                <Radio.Button value="brand">品牌搜索</Radio.Button>
                <Radio.Button value="scene">联系方式</Radio.Button>
              </Radio.Group>
              <Select
                value={platform}
                onChange={(v) => { setPlatform(v); setRankPage(1); }}
                style={{ width: 150 }}
                options={platforms.map(p => ({ label: p.pt, value: p.pt }))}
              />
              <Input.Search
                placeholder="搜索关键词"
                value={searchKeyword}
                onChange={(e) => setSearchKeyword(e.target.value)}
                onSearch={onSearch}
                style={{ width: 250 }}
              />
            </div>

            <Table
              columns={columns}
              dataSource={rankList}
              rowKey="id"
              loading={rankLoading}
              pagination={false}
              size="middle"
            />

            <div style={{ textAlign: 'right', marginTop: 16 }}>
              <Pagination
                current={rankPage}
                total={rankTotal}
                pageSize={20}
                onChange={(page) => setRankPage(page)}
                showTotal={(total) => `共 ${total} 条`}
              />
            </div>
          </Card>
        </>
      )}
    </div>
  );
}
