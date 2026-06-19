'use client';

import React, { useState, useEffect } from 'react';
import { Table, Button, Space, Input, Select, message, Tag, Modal, Form, Tooltip } from 'antd';
import { ReloadOutlined, EditOutlined, PlusOutlined } from '@ant-design/icons';
import api from '@/lib/api';

interface MaintainItem {
  id: number;
  zlgjcid?: number;
  distillateKeyword?: string;
  expandedKeyword?: string;
  platform?: string;
  url?: string;
  hasLxfs?: number;
  userId?: string;
}

interface UserOption {
  id: string;
  username: string;
  level: string;
}

interface PlatformOption {
  name: string;
}

export default function MaintainPage() {
  const [loading, setLoading] = useState(false);
  const [list, setList] = useState<MaintainItem[]>([]);
  const [total, setTotal] = useState(0);
  const [users, setUsers] = useState<UserOption[]>([]);
  const [platforms, setPlatforms] = useState<PlatformOption[]>([]);
  const [selectedUserId, setSelectedUserId] = useState<string>('');
  const [selectedPlatform, setSelectedPlatform] = useState<string>('');
  const [keyword, setKeyword] = useState('');
  const [pageNum, setPageNum] = useState(1);
  const [pageSize, setPageSize] = useState(20);
  const [editModalVisible, setEditModalVisible] = useState(false);
  const [editingItem, setEditingItem] = useState<MaintainItem | null>(null);
  const [form] = Form.useForm();

  const fetchUsers = async () => {
    try {
      const res = await api.get('/users/queryUserList', { params: { pageNum: 1, pageSize: 999999 } });
      if (res.data?.code === 200) {
        const allUsers = res.data.data?.list || [];
        const userList = allUsers.filter((u: UserOption) => u.username !== 'admin');
        setUsers(userList);
        if (userList.length > 0 && !selectedUserId) {
          setSelectedUserId(String(userList[0].id));
        }
      }
    } catch (e) {
      // 忽略
    }
  };

  const fetchPlatforms = async () => {
    try {
      const res = await api.get('/pt/list');
      if (res.data?.code === 200) {
        setPlatforms(res.data.data || []);
      }
    } catch (e) {
      // 忽略
    }
  };

  const fetchList = async () => {
    if (!selectedUserId) return;
    setLoading(true);
    try {
      const params: any = {
        userId: selectedUserId,
        pageNum,
        pageSize,
      };
      if (selectedPlatform) params.pt = selectedPlatform;
      if (keyword) params.keyword = keyword;

      const res = await api.get('/zlgjc/maintenanceList', { params });
      if (res.data?.code === 200) {
        const data = res.data.data;
        setList(data?.list || []);
        setTotal(data?.total || 0);
      } else {
        message.error(res.data?.message || '获取列表失败');
      }
    } catch (e) {
      message.error('获取列表失败');
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => {
    fetchUsers();
    fetchPlatforms();
  }, []);

  useEffect(() => {
    if (selectedUserId) {
      fetchList();
    }
  }, [selectedUserId, pageNum, pageSize]);

  const onSearch = () => {
    setPageNum(1);
    fetchList();
  };

  const openEdit = (item: MaintainItem) => {
    setEditingItem(item);
    form.setFieldsValue({
      url: item.url || '',
      hasLxfs: item.hasLxfs === 1 ? '1' : '0',
    });
    setEditModalVisible(true);
  };

  const handleUpdateUrl = async (values: any) => {
    if (!editingItem) return;
    try {
      const res = await api.post('/zlgjc/updateUrl', {
        id: editingItem.id,
        url: values.url,
        hasLxfs: values.hasLxfs,
      });
      if (res.data?.code === 200) {
        message.success('更新成功');
        setEditModalVisible(false);
        fetchList();
      } else {
        message.error(res.data?.message || '更新失败');
      }
    } catch (e) {
      message.error('更新失败');
    }
  };

  const columns = [
    { title: 'ID', dataIndex: 'id', width: 80 },
    { title: '蒸馏关键词', dataIndex: 'distillateKeyword', width: 150 },
    { title: '扩展关键词', dataIndex: 'expandedKeyword', width: 200 },
    {
      title: '平台', dataIndex: 'platform', width: 120,
      render: (v: string) => v ? <Tag color="blue">{v}</Tag> : '-',
    },
    {
      title: 'URL', dataIndex: 'url', width: 250,
      render: (v: string) => {
        if (!v) return '-';
        const display = v.length > 40 ? v.substring(0, 40) + '...' : v;
        return <Tooltip title={v}><a href={v} target="_blank" rel="noopener noreferrer">{display}</a></Tooltip>;
      },
    },
    {
      title: '联系方式', dataIndex: 'hasLxfs', width: 100,
      render: (v: number) => v === 1 ? <Tag color="green">有</Tag> : <Tag>无</Tag>,
    },
    {
      title: '操作', width: 100, fixed: 'right' as const,
      render: (_: any, record: MaintainItem) => (
        <Button size="small" icon={<EditOutlined />} onClick={() => openEdit(record)}>编辑</Button>
      ),
    },
  ];

  return (
    <div>
      <div style={{ display: 'flex', justifyContent: 'space-between', marginBottom: 16 }}>
        <h2 style={{ margin: 0 }}>核心关键词维护</h2>
        <Button icon={<ReloadOutlined />} onClick={fetchList}>刷新</Button>
      </div>

      <Space style={{ marginBottom: 16 }} wrap>
        <span>用户：</span>
        <Select
          style={{ width: 180 }}
          value={selectedUserId}
          onChange={(v) => { setSelectedUserId(v); setPageNum(1); }}
          options={users.map((u) => ({ value: String(u.id), label: u.username }))}
          placeholder="选择用户"
        />
        <span>平台：</span>
        <Select
          style={{ width: 150 }}
          value={selectedPlatform}
          onChange={(v) => { setSelectedPlatform(v); }}
          allowClear
          placeholder="全部平台"
          options={platforms.map((p) => ({ value: p.name, label: p.name }))}
        />
        <span>关键词：</span>
        <Input
          style={{ width: 200 }}
          value={keyword}
          onChange={(e) => setKeyword(e.target.value)}
          onPressEnter={onSearch}
          placeholder="搜索关键词"
          allowClear
        />
        <Button type="primary" onClick={onSearch}>查询</Button>
      </Space>

      <Table
        loading={loading}
        dataSource={list}
        columns={columns}
        rowKey="id"
        scroll={{ x: 1000 }}
        pagination={{
          current: pageNum,
          pageSize,
          total,
          showSizeChanger: true,
          showTotal: (t) => `共 ${t} 条`,
          onChange: (page, size) => {
            setPageNum(page);
            setPageSize(size || 20);
          },
        }}
        size="small"
      />

      <Modal
        title="编辑URL"
        open={editModalVisible}
        onCancel={() => setEditModalVisible(false)}
        onOk={() => form.submit()}
        destroyOnClose
      >
        <Form form={form} layout="vertical" onFinish={handleUpdateUrl}>
          <Form.Item label="URL" name="url">
            <Input.TextArea rows={3} placeholder="请输入URL" />
          </Form.Item>
          <Form.Item label="是否有联系方式" name="hasLxfs" initialValue="0">
            <select style={{ width: '100%', padding: '6px 12px', border: '1px solid #d9d9d9', borderRadius: 4 }}>
              <option value="0">无</option>
              <option value="1">有</option>
            </select>
          </Form.Item>
        </Form>
      </Modal>
    </div>
  );
}
