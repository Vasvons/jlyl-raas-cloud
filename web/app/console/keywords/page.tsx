'use client';

import React, { useState, useEffect } from 'react';
import { Table, Button, Space, Input, Popconfirm, message, Select, Card, Tabs, Tag } from 'antd';
import { PlusOutlined, DeleteOutlined, ReloadOutlined } from '@ant-design/icons';
import api from '@/lib/api';

interface PPItem {
  id: number;
  userId: string;
  pp: string;
}

interface DistillateKeywordItem {
  id: number;
  userId: string;
  distillateKeyword: string;
}

interface UserOption {
  id: string;
  username: string;
  level: string;
}

export default function KeywordsPage() {
  const [activeTab, setActiveTab] = useState('pp');
  const [loading, setLoading] = useState(false);
  const [users, setUsers] = useState<UserOption[]>([]);
  const [selectedUserId, setSelectedUserId] = useState<string>('');

  // 品牌词
  const [ppList, setPpList] = useState<PPItem[]>([]);
  const [newPp, setNewPp] = useState('');

  // 蒸馏关键词
  const [dkList, setDkList] = useState<DistillateKeywordItem[]>([]);
  const [newDk, setNewDk] = useState('');

  // 获取用户列表
  useEffect(() => {
    (async () => {
      try {
        const res = await api.get('/users/queryUserList', { params: { pageNum: 1, pageSize: 999999 } });
        if (res.data?.code === 200) {
          const allUsers = res.data.data?.list || [];
          const userList = allUsers.filter((u: UserOption) => u.username !== 'admin');
          setUsers(userList);
          if (userList.length > 0) {
            setSelectedUserId(String(userList[0].id));
          }
        }
      } catch (e) {
        // 忽略
      }
    })();
  }, []);

  // 获取品牌词
  const fetchPp = async (userId: string) => {
    if (!userId) return;
    setLoading(true);
    try {
      const res = await api.get('/pp/list', { params: { userId } });
      if (res.data?.code === 200) {
        setPpList(res.data.data || []);
      }
    } catch (e) {
      message.error('获取品牌词失败');
    } finally {
      setLoading(false);
    }
  };

  // 获取蒸馏关键词
  const fetchDk = async (userId: string) => {
    if (!userId) return;
    setLoading(true);
    try {
      const res = await api.get('/dstillateKeyword/getAllDstillateKeyword', { params: { userId, pageNum: 1, pageSize: 9999999 } });
      if (res.data?.code === 200) {
        const data = res.data.data;
        setDkList(Array.isArray(data) ? data : (data?.list || []));
      }
    } catch (e) {
      message.error('获取蒸馏关键词失败');
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => {
    if (selectedUserId) {
      if (activeTab === 'pp') fetchPp(selectedUserId);
      else fetchDk(selectedUserId);
    }
  }, [selectedUserId, activeTab]);

  const onUserChange = (uid: string) => {
    setSelectedUserId(uid);
  };

  const addPp = async () => {
    if (!newPp.trim() || !selectedUserId) return;
    try {
      const res = await api.post('/pp/add', { userId: selectedUserId, pp: newPp.trim() });
      if (res.data?.code === 200) {
        message.success('添加成功');
        setNewPp('');
        fetchPp(selectedUserId);
      } else {
        message.error(res.data?.message || '添加失败');
      }
    } catch (e) {
      message.error('添加失败');
    }
  };

  const deletePp = async (id: number) => {
    try {
      const res = await api.delete(`/pp/${id}`);
      if (res.data?.code === 200) {
        message.success('删除成功');
        fetchPp(selectedUserId);
      } else {
        message.error(res.data?.message || '删除失败');
      }
    } catch (e) {
      message.error('删除失败');
    }
  };

  const addDk = async () => {
    if (!newDk.trim() || !selectedUserId) return;
    try {
      const res = await api.post('/dstillateKeyword/insertDstillateKeyword', { userId: selectedUserId, distillateKeyword: newDk.trim() });
      if (res.data?.code === 200) {
        message.success('添加成功');
        setNewDk('');
        fetchDk(selectedUserId);
      } else {
        message.error(res.data?.message || '添加失败');
      }
    } catch (e) {
      message.error('添加失败');
    }
  };

  const deleteDk = async (id: number) => {
    try {
      const res = await api.get('/dstillateKeyword/deleteDstillateKeyword', { params: { id } });
      if (res.data?.code === 200) {
        message.success('删除成功');
        fetchDk(selectedUserId);
      } else {
        message.error(res.data?.message || '删除失败');
      }
    } catch (e) {
      message.error('删除失败');
    }
  };

  const ppColumns = [
    { title: 'ID', dataIndex: 'id', width: 80 },
    { title: '品牌词', dataIndex: 'pp' },
    {
      title: '操作', width: 100,
      render: (_: any, record: PPItem) => (
        <Popconfirm title="确定删除？" onConfirm={() => deletePp(record.id)}>
          <Button size="small" danger icon={<DeleteOutlined />}>删除</Button>
        </Popconfirm>
      ),
    },
  ];

  const dkColumns = [
    { title: 'ID', dataIndex: 'id', width: 80 },
    { title: '蒸馏关键词', dataIndex: 'distillateKeyword' },
    {
      title: '操作', width: 100,
      render: (_: any, record: DistillateKeywordItem) => (
        <Popconfirm title="确定删除？" onConfirm={() => deleteDk(record.id)}>
          <Button size="small" danger icon={<DeleteOutlined />}>删除</Button>
        </Popconfirm>
      ),
    },
  ];

  return (
    <div>
      <div style={{ display: 'flex', justifyContent: 'space-between', marginBottom: 16 }}>
        <h2 style={{ margin: 0 }}>关键词配置</h2>
        <Space>
          <span>选择用户：</span>
          <Select
            style={{ width: 200 }}
            value={selectedUserId}
            onChange={onUserChange}
            placeholder="请选择用户"
            options={users.map((u) => ({ value: String(u.id), label: u.username }))}
          />
          <Button icon={<ReloadOutlined />} onClick={() => {
            if (activeTab === 'pp') fetchPp(selectedUserId);
            else fetchDk(selectedUserId);
          }}>刷新</Button>
        </Space>
      </div>

      <Tabs
        activeKey={activeTab}
        onChange={setActiveTab}
        items={[
          {
            key: 'pp',
            label: '品牌词',
            children: (
              <div>
                <Space style={{ marginBottom: 16 }}>
                  <Input
                    placeholder="请输入品牌词"
                    value={newPp}
                    onChange={(e) => setNewPp(e.target.value)}
                    onPressEnter={addPp}
                    style={{ width: 300 }}
                  />
                  <Button type="primary" icon={<PlusOutlined />} onClick={addPp}>添加品牌词</Button>
                </Space>
                <Table
                  loading={loading}
                  dataSource={ppList}
                  columns={ppColumns}
                  rowKey="id"
                  pagination={{ pageSize: 20 }}
                  size="small"
                />
              </div>
            ),
          },
          {
            key: 'dk',
            label: '蒸馏关键词',
            children: (
              <div>
                <Space style={{ marginBottom: 16 }}>
                  <Input
                    placeholder="请输入蒸馏关键词"
                    value={newDk}
                    onChange={(e) => setNewDk(e.target.value)}
                    onPressEnter={addDk}
                    style={{ width: 300 }}
                  />
                  <Button type="primary" icon={<PlusOutlined />} onClick={addDk}>添加蒸馏关键词</Button>
                </Space>
                <Table
                  loading={loading}
                  dataSource={dkList}
                  columns={dkColumns}
                  rowKey="id"
                  pagination={{ pageSize: 20 }}
                  size="small"
                />
              </div>
            ),
          },
        ]}
      />
    </div>
  );
}
