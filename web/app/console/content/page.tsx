'use client';

import { useEffect, useState } from 'react';
import { Card, Col, Row, Statistic, Progress, Table, Tag, Empty, Spin } from 'antd';
import api from '@/lib/api';

interface DashboardData {
  coverage: { total: number; covered: number };
}

export default function ContentDashboardPage() {
  const [loading, setLoading] = useState(true);
  const [data, setData] = useState<DashboardData | null>(null);

  useEffect(() => {
    api.get('/content/dashboard/stats').then(res => {
      if (res.data?.code === 200) setData(res.data.data);
    }).finally(() => setLoading(false));
  }, []);

  if (loading) return <Spin />;
  if (!data) return <Empty description="暂无数据" />;

  const coverageRate = data.coverage.total > 0
    ? Math.round((data.coverage.covered / data.coverage.total) * 100)
    : 0;

  return (
    <div>
      <h2 style={{ marginBottom: 24 }}>内容中枢仪表盘</h2>
      <Row gutter={16}>
        <Col span={6}>
          <Card>
            <Statistic title="蒸馏词库总词数" value={data.coverage.total} />
          </Card>
        </Col>
        <Col span={6}>
          <Card>
            <Statistic title="已生成文章词数" value={data.coverage.covered} />
          </Card>
        </Col>
        <Col span={6}>
          <Card>
            <Statistic title="未覆盖词数" value={data.coverage.total - data.coverage.covered} />
          </Card>
        </Col>
        <Col span={6}>
          <Card>
            <Statistic title="覆盖率" value={coverageRate} suffix="%" />
          </Card>
        </Col>
      </Row>
      <Card title="关键词覆盖度" style={{ marginTop: 24 }}>
        <Progress percent={coverageRate} status={coverageRate >= 80 ? 'success' : 'active'} />
        <p style={{ marginTop: 12, color: '#8c8c8c' }}>
          已覆盖 {data.coverage.covered} / {data.coverage.total} 个蒸馏关键词
        </p>
      </Card>
    </div>
  );
}
