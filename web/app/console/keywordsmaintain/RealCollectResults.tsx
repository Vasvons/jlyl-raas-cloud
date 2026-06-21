'use client';

import React, { useState, useEffect, useCallback } from 'react';
import { Table, Card, Select, DatePicker, Button, Space, message, Tag, Modal } from 'antd';
import { SearchOutlined, DeleteOutlined, EyeOutlined } from '@ant-design/icons';
import dayjs from 'dayjs';
import api from '@/lib/api';

const { RangePicker } = DatePicker;

export default function RealCollectResults() {
  const [loading, setLoading] = useState(false);
  const [data, setData] = useState<any[]>([]);
  const [total, setTotal] = useState(0);
  const [pageNum, setPageNum] = useState(1);
  const [pageSize, setPageSize] = useState(20);
  const [users, setUsers] = useState<any[]>([]);
  const [platforms, setPlatforms] = useState<any[]>([]);
  const [filters, setFilters] = useState({
    userId: '' as string,
    platform: '' as string,
    keywordType: undefined as number | undefined,
    dateRange: null as [dayjs.Dayjs, dayjs.Dayjs] | null,
  });
  const [contactModalVisible, setContactModalVisible] = useState(false);
  const [currentContacts, setCurrentContacts] = useState<any>(null);

  useEffect(() => {
    api.get('/users/queryUserList').then(res => {
      if (res.data?.code === 200) {
        const list = res.data.data?.list || [];
        setUsers(list.filter((u: any) => u.level === '0'));
      }
    }).catch(() => {});

    api.get('/pt/list').then(res => {
      if (res.data?.code === 200) {
        setPlatforms(res.data.data || []);
      }
    }).catch(() => {});
  }, []);

  const loadData = useCallback(async () => {
    setLoading(true);
    try {
      const params: any = { pageNum, pageSize };
      if (filters.userId) params.userId = filters.userId;
      if (filters.platform) params.platform = filters.platform;
      if (filters.keywordType !== undefined) params.keywordType = filters.keywordType;
      if (filters.dateRange) {
        params.startTime = filters.dateRange[0].format('YYYY-MM-DD HH:mm:ss');
        params.endTime = filters.dateRange[1].format('YYYY-MM-DD HH:mm:ss');
      }
      const res = await api.get('/real-collect/results', { params });
      if (res.data?.code === 200) {
        setData(res.data.data?.list || []);
        setTotal(res.data.data?.total || 0);
      }
    } catch (e: any) {
      message.error(e?.response?.data?.message || '加载失败');
    } finally {
      setLoading(false);
    }
  }, [pageNum, pageSize, filters]);

  useEffect(() => {
    loadData();
  }, [loadData]);

  const handleDelete = async (id: number) => {
    try {
      const res = await api.delete(`/real-collect/results/${id}`);
      if (res.data?.code === 200) {
        message.success('删除成功');
        loadData();
      }
    } catch (e: any) {
      message.error(e?.response?.data?.message || '删除失败');
    }
  };

  const handleViewContacts = (contacts: any) => {
    setCurrentContacts(contacts);
    setContactModalVisible(true);
  };

  const getJumpUrl = (record: any) => {
    if (record.share_url) return record.share_url;
    if (record.static_page_id) return `${window.location.origin}/api/real-collect/results/${record.id}/page`;
    return null;
  };

  const columns = [
    { title: '关键词', dataIndex: 'keyword', key: 'keyword', width: 200, ellipsis: true },
    {
      title: '词库', dataIndex: 'keyword_type', key: 'keyword_type', width: 80,
      render: (v: number) => v === 1 ? <Tag color="blue">品牌词</Tag> : <Tag>蒸馏词</Tag>
    },
    { title: '平台', dataIndex: 'platform', key: 'platform', width: 100 },
    {
      title: '品牌词匹配', key: 'matched_brands', width: 150,
      render: (_: any, record: any) => record.matched_brands?.length > 0
        ? record.matched_brands.map((b: string) => <Tag color="green" key={b}>{b}</Tag>)
        : <span style={{ color: '#999' }}>-</span>
    },
    {
      title: '联系方式', key: 'has_contact', width: 100,
      render: (_: any, record: any) => record.has_contact
        ? <Button type="link" size="small" onClick={() => handleViewContacts(record.contacts)}>查看</Button>
        : <span style={{ color: '#999' }}>-</span>
    },
    {
      title: '跳转链接', key: 'url', width: 120,
      render: (_: any, record: any) => {
        const url = getJumpUrl(record);
        return url
          ? <Button type="link" size="small" href={url} target="_blank" icon={<EyeOutlined />}>打开</Button>
          : <span style={{ color: '#999' }}>-</span>;
      }
    },
    {
      title: '查询时间', dataIndex: 'query_time', key: 'query_time', width: 160,
      render: (v: string) => v ? dayjs(v).format('YYYY-MM-DD HH:mm:ss') : '-'
    },
    {
      title: '操作', key: 'action', width: 80,
      render: (_: any, record: any) => (
        <Button type="link" danger size="small" icon={<DeleteOutlined />} onClick={() => handleDelete(record.id)}>删除</Button>
      )
    },
  ];

  return (
    <div>
      <Card style={{ marginBottom: 16 }}>
        <Space wrap>
          <Select
            placeholder="选择用户"
            style={{ width: 180 }}
            allowClear
            value={filters.userId || undefined}
            onChange={v => setFilters({ ...filters, userId: v || '' })}
          >
            {users.map(u => <Select.Option key={u.id} value={String(u.id)}>{u.username}</Select.Option>)}
          </Select>
          <Select
            placeholder="选择平台"
            style={{ width: 140 }}
            allowClear
            value={filters.platform || undefined}
            onChange={v => setFilters({ ...filters, platform: v || '' })}
          >
            {platforms.map(p => <Select.Option key={p.pt} value={p.pt}>{p.pt}</Select.Option>)}
          </Select>
          <Select
            placeholder="词库类型"
            style={{ width: 120 }}
            allowClear
            value={filters.keywordType}
            onChange={v => setFilters({ ...filters, keywordType: v })}
          >
            <Select.Option value={0}>蒸馏词</Select.Option>
            <Select.Option value={1}>品牌词</Select.Option>
          </Select>
          <RangePicker
            showTime
            value={filters.dateRange}
            onChange={v => setFilters({ ...filters, dateRange: v as any })}
          />
          <Button type="primary" icon={<SearchOutlined />} onClick={loadData}>查询</Button>
        </Space>
      </Card>

      <Table
        columns={columns}
        dataSource={data}
        rowKey="id"
        loading={loading}
        pagination={{
          current: pageNum,
          pageSize,
          total,
          showSizeChanger: true,
          onChange: (page, size) => { setPageNum(page); setPageSize(size); },
        }}
        scroll={{ x: 1000 }}
      />

      <Modal
        title="联系方式详情"
        open={contactModalVisible}
        onCancel={() => setContactModalVisible(false)}
        footer={null}
      >
        {currentContacts && (
          <div>
            {currentContacts.phones?.length > 0 && (
              <div style={{ marginBottom: 8 }}>
                <strong>电话:</strong>
                {currentContacts.phones.map((p: string) => <Tag key={p}>{p}</Tag>)}
              </div>
            )}
            {currentContacts.emails?.length > 0 && (
              <div style={{ marginBottom: 8 }}>
                <strong>邮箱:</strong>
                {currentContacts.emails.map((e: string) => <Tag key={e}>{e}</Tag>)}
              </div>
            )}
            {currentContacts.urls?.length > 0 && (
              <div style={{ marginBottom: 8 }}>
                <strong>网址:</strong>
                {currentContacts.urls.map((u: string) => <Tag key={u}>{u}</Tag>)}
              </div>
            )}
            {currentContacts.ims?.length > 0 && (
              <div style={{ marginBottom: 8 }}>
                <strong>即时通讯:</strong>
                {currentContacts.ims.map((i: string) => <Tag key={i}>{i}</Tag>)}
              </div>
            )}
            {!currentContacts.phones?.length && !currentContacts.emails?.length &&
             !currentContacts.urls?.length && !currentContacts.ims?.length && (
              <span style={{ color: '#999' }}>无联系方式</span>
            )}
          </div>
        )}
      </Modal>
    </div>
  );
}
