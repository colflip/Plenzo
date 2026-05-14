/**
 * Application metadata routes.
 */

const express = require('express');
const router = express.Router();
const { getVersionMeta } = require('../services/versionService');

router.get('/version', async (req, res, next) => {
    try {
        const meta = await getVersionMeta();
        res.json(meta);
    } catch (error) {
        next(error);
    }
});

module.exports = router;
