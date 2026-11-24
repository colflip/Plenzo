/**
 * 应用元数据路由
 * @description GET /api/meta/version：返回版本徽章所需的提交与环境信息。
 * @module routes/meta
 */

const express = require('express');
const router = express.Router();
const { getVersionMeta } = require('../services/version-service');
const { successResponse } = require('../utils/response');

router.get('/version', async (req, res, next) => {
    try {
        const meta = await getVersionMeta();
        res.json(successResponse(meta));
    } catch (error) {
        next(error);
    }
});

module.exports = router;
