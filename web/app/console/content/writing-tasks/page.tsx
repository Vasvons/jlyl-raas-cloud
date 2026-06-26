'use client';

import { useEffect, useState } from 'react';
import { Card, Button, Progress, Tag, Empty, Spin, Space, Popconfirm, message, Row, Col } from 'antd';
import { PlusOutlined, ReloadOutlined, DeleteOutlined } from '@ant-design/icons';
import Link from 'next/link';
import api from '@/lib/api';

const STATUS_MAP: Record<string, { color: string; text: string }> = {
  pending: { color: 'default', text: '等待中' },
  processing: { color: 'processing', text: '进行中' },
  completed: { color: 'success', text: '已完成' },
  failed: { color: 'error', text: '失败' },
  partial: { color: 'warning', text: '部分成功' },
};

export default function WritingTasksPage() {
  const [list, setList] = useState<any[]>([]);
  const [loading, setLoading] = useState(false);

  const load = async () => {
    setLoading(true);
    try {
      const res = await api.get('/content/writing-tasks');
      if (res.data?.code === 200) setList(res.data.data.list);
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => {
    load();
    const timer = setInterval(load, 5000); // 5秒轮询进度
    return () => clearInterval(timer);
  }, []);

  const handleDelete = async (id: number) => {
    await api.delete(`/content/writing-tasks/${id}`);
    message.success('删除成功');
    load();
  };

  return (
    <div>
      <Space style={{ marginBottom: 16 }}>
        <h2 style={{ margin: 0 }}>写作任务</h2>
        <Link href="/console/content/writing-tasks/new"><Button type="primary" icon={<PlusOutlined />}>新建任务</Button></Link>
        <Button icon={<ReloadOutlined />} onClick={load} />
      </Space>
      {loading ? <Spin /> : list.length === 0 ? <Empty description="暂无任务" /> : (
        <Row gutter={[16, 16]}>
          {list.map(task => {
            const pct = task.total_count > 0 ? Math.round((task.completed_count / task.total_count) * 100) : 0;
            const st = STATUS_MAP[task.status] || STATUS_MAP.pending;
            return (
              <Col key={task.id} span={12}>
                <Card title={task.task_name || `任务 #${task.id}`}
                  extra={<Tag color={st.color}>{st.text}</Tag>}
                  actions={[
                    <Popconfirm key="del" title="删除任务？" onConfirm={() => handleDelete(task.id)}>
                      <DeleteOutlined /> 删除
                    </Popconfirm>,
                  ]}>
                  <p>指令：{task.instruction_name || '-'}</p>
                  <p>知识库：{task.knowledge_name || '-'}</p>
                  <Progress percent={pct} status={task.status === 'failed' ? 'exception' : task.status === 'completed' ? 'success' : 'active'} />
                  <p style={{ marginTop: 8, color: '#8c8c8c' }}>
                    成功 {task.completed_count} / 失败 {task.failed_count} / 共 {task.total_count}
                  </p>
                </Card>
              </Col>
            );
          })}
        </Row>
      )}
    </div>
  );
}
