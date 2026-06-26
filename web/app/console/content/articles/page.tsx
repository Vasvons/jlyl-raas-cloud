'use client';

import { useEffect, useState } from 'react';
import { Table, Button, Input, Select, Space, Tag, message, Popconfirm } from 'antd';
import { ReloadOutlined, DeleteOutlined, EditOutlined, ThunderboltOutlined } from '@ant-design/icons';
import Link from 'next/link';
import api from '@/lib/api';

const STATUS_TAGS: Record<string, { color: string; text: string }> = {
  draft: { color: 'default', text: '草稿' },
  generated: { color: 'blue', text: '已生成' },
  editing: { color: 'orange', text: '编辑中' },
  ready: { color: 'gold', text: '待发布' },
  published: { color: 'green', text: '已发布' },
  archived: { color: 'default', text: '归档' },
};

export default function ArticlesPage() {
  const [list, setList] = useState<any[]>([]);
  const [total, setTotal] = useState(0);
  const [loading, setLoading] = useState(false);
  const [page, setPage] = useState(1);
  const [keyword, setKeyword] = useState('');
  const [status, setStatus] = useState<string>('');

  const load = async () => {
    setLoading(true);
    try {
      const res = await api.get('/content/articles', { params: { page, pageSize: 20, keyword, status } });
      if (res.data?.code === 200) {
        setList(res.data.data.list);
        setTotal(res.data.data.total);
      }
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => { load(); }, [page, status]);

  const handleRegenerate = async (id: number) => {
    await api.post(`/content/articles/${id}/regenerate`);
    message.success('重新生成已开始');
    setTimeout(load, 2000);
  };

  const handleDelete = async (id: number) => {
    await api.delete(`/content/articles/${id}`);
    message.success('删除成功');
    load();
  };

  const columns = [
    { title: '标题', dataIndex: 'title', ellipsis: true,
      render: (t: string, r: any) => <Link href={`/console/content/articles/${r.id}`}>{t}</Link> },
    { title: '核心关键词', dataIndex: 'core_keyword', width: 200 },
    { title: '状态', dataIndex: 'status', width: 100,
      render: (s: string) => { const tag = STATUS_TAGS[s] || STATUS_TAGS.draft; return <Tag color={tag.color}>{tag.text}</Tag>; } },
    { title: '字数', dataIndex: 'word_count', width: 80 },
    { title: '生成时间', dataIndex: 'create_time', width: 180 },
    {
      title: '操作', width: 200, render: (_: any, r: any) => (
        <Space>
          <Link href={`/console/content/articles/edit?id=${r.id}`}>
            <Button size="small" type="text" icon={<EditOutlined />} />
          </Link>
          <Button size="small" type="text" icon={<ThunderboltOutlined />} onClick={() => handleRegenerate(r.id)} />
          <Popconfirm title="确定删除？" onConfirm={() => handleDelete(r.id)}>
            <Button size="small" type="text" icon={<DeleteOutlined />} danger />
          </Popconfirm>
        </Space>
      ),
    },
  ];

  return (
    <div>
      <h2 style={{ marginBottom: 24 }}>文章管理</h2>
      <Space style={{ marginBottom: 16 }}>
        <Input.Search placeholder="搜索标题/关键词" value={keyword}
          onChange={e => setKeyword(e.target.value)} onSearch={() => { setPage(1); load(); }}
          style={{ width: 300 }} />
        <Select placeholder="状态" allowClear value={status || undefined}
          onChange={v => { setStatus(v || ''); setPage(1); }} style={{ width: 120 }}
          options={Object.entries(STATUS_TAGS).map(([k, v]) => ({ value: k, label: v.text }))} />
        <Button icon={<ReloadOutlined />} onClick={load} />
      </Space>
      <Table columns={columns} dataSource={list} rowKey="id" loading={loading}
        pagination={{ current: page, total, pageSize: 20, onChange: setPage }} />
    </div>
  );
}
