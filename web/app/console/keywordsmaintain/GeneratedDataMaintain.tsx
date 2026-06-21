'use client';

import React, { useState, useEffect } from 'react';
import { Table, Button, Space, Input, Select, message, Tag, Checkbox, Tooltip, Card } from 'antd';
import { ReloadOutlined, SaveOutlined } from '@ant-design/icons';
import api from '@/lib/api';

interface MaintainItem {
  distillateKeyword: string;
  expandedKeyword: string;
  platform: string;
  zlgjcid?: number;
  urlId?: number;
  url?: string;
  hasLxfs?: number;
  // 前端编辑状态
  _editingUrl?: string;
  _editingHasLxfs?: boolean;
  _saving?: boolean;
}

interface UserOption {
  id: string;
  username: string;
  level: string;
}

interface PlatformOption {
  name: string;
}

export default function GeneratedDataMaintain() {
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
      const params: any = { userId: selectedUserId, pageNum, pageSize };
      if (selectedPlatform) params.pt = selectedPlatform;
      if (keyword) params.keyword = keyword;

      const res = await api.get('/zlgjc/maintenanceList', { params });
      if (res.data?.code === 200) {
        const data = res.data.data;
        const items = (data?.list || []).map((item: MaintainItem) => ({
          ...item,
          _editingUrl: item.url || '',
          _editingHasLxfs: item.hasLxfs === 1,
          _saving: false,
        }));
        setList(items);
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
    if (selectedUserId) fetchList();
  }, [selectedUserId, pageNum, pageSize]);

  const onSearch = () => {
    setPageNum(1);
    fetchList();
  };

  // 行内保存
  const handleSave = async (record: MaintainItem, index: number) => {
    const newList = [...list];
    newList[index] = { ...record, _saving: true };
    setList(newList);

    try {
      const { _editingUrl, _editingHasLxfs, urlId, zlgjcid, platform } = record;
      if (urlId) {
        // 更新现有记录
        const res = await api.post('/zlgjc/updateUrl', {
          id: urlId,
          url: _editingUrl || '',
          hasLxfs: _editingHasLxfs,
        });
        if (res.data?.code !== 200) {
          message.error(res.data?.message || '保存失败');
          return;
        }
      } else if (zlgjcid) {
        // 新增跳转链接记录
        const res = await api.post('/zlgjc/insertUrl', {
          zlgjcid,
          pt: platform,
          url: _editingUrl || '',
          hasLxfs: _editingHasLxfs,
        });
        if (res.data?.code !== 200) {
          message.error(res.data?.message || '保存失败');
          return;
        }
      } else {
        message.warning('该记录无法保存（缺少关键词关联）');
        return;
      }
      message.success('保存成功');
      // 更新本地数据
      newList[index] = {
        ...record,
        url: _editingUrl,
        hasLxfs: _editingHasLxfs ? 1 : 0,
        _saving: false,
      };
      setList(newList);
    } catch (e) {
      message.error('保存失败');
      newList[index] = { ...record, _saving: false };
      setList(newList);
    }
  };

  // 行内编辑
  const handleFieldChange = (index: number, field: '_editingUrl' | '_editingHasLxfs', value: string | boolean) => {
    const newList = [...list];
    newList[index] = { ...newList[index], [field]: value };
    setList(newList);
  };

  const columns = [
    {
      title: '蒸馏关键词', dataIndex: 'distillateKeyword', width: 200,
      render: (v: string) => v || '-',
    },
    {
      title: '核心词', dataIndex: 'expandedKeyword', width: 150,
      render: (v: string) => v || '-',
    },
    {
      title: '平台', dataIndex: 'platform', width: 100,
      render: (v: string) => v ? <Tag color="blue">{v}</Tag> : '-',
    },
    {
      title: '跳转链接', width: 300,
      render: (_: any, record: MaintainItem) => (
        <Input
          size="small"
          value={record._editingUrl}
          onChange={(e) => handleFieldChange(list.indexOf(record), '_editingUrl', e.target.value)}
          placeholder="填写跳转链接"
          style={{ width: '100%' }}
        />
      ),
    },
    {
      title: '有联系方式', width: 100, align: 'center' as const,
      render: (_: any, record: MaintainItem) => (
        <Checkbox
          checked={record._editingHasLxfs}
          onChange={(e) => handleFieldChange(list.indexOf(record), '_editingHasLxfs', e.target.checked)}
        >
          {record._editingHasLxfs ? <Tag color="green">是</Tag> : <Tag>否</Tag>}
        </Checkbox>
      ),
    },
    {
      title: '操作', width: 80, fixed: 'right' as const,
      render: (_: any, record: MaintainItem) => {
        const index = list.indexOf(record);
        const changed = record._editingUrl !== (record.url || '') || record._editingHasLxfs !== (record.hasLxfs === 1);
        return (
          <Button
            size="small"
            type="primary"
            icon={<SaveOutlined />}
            loading={record._saving}
            disabled={!changed}
            onClick={() => handleSave(record, index)}
          >
            保存
          </Button>
        );
      },
    },
  ];

  return (
    <div>
      <div className="console-page-title">
        <span className="console-page-title-text">收录跳转维护</span>
        <Button icon={<ReloadOutlined />} onClick={fetchList}>刷新</Button>
      </div>

      <div className="console-tip console-tip-info">
        <b>说明：</b>本页面维护数据生成任务生成的关键词收录记录。在每条记录后填写跳转链接，并勾选"有联系方式"标记该收录是否出现了联系方式。
        勾选了"有联系方式"的记录将出现在 GEO 报告页面的搜索排名的"联系方式"分类下。
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

      <Card size="small">
        <Table
          loading={loading}
          dataSource={list}
          columns={columns}
          rowKey={(record) => `${record.distillateKeyword}-${record.platform}-${record.expandedKeyword}`}
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
      </Card>
    </div>
  );
}
