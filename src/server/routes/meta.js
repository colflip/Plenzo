/**
 * Application metadata routes.
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
