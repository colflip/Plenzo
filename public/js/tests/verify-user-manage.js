/**
 * User Management UI Refactor - Verification Tests
 * Run this in the browser console to verify the implementation.
 */

async function runUserManagementTests() {
    console.group('User Management UI Verification');
    let passed = 0;
    let failed = 0;

    const assert = (condition, message) => {
        if (condition) {
            console.log(`✅ PASS: ${message}`);
            passed++;
        } else {
            console.error(`❌ FAIL: ${message}`);
            failed++;
        }
    };

    // 1. Verify Header Tabs Structure
    const tabsContainer = document.getElementById('userRoleTabs');
    assert(tabsContainer, 'Tabs container (#userRoleTabs) exists');
    if (tabsContainer) {
        const tabs = tabsContainer.querySelectorAll('.tab-btn');
        assert(tabs.length === 3, 'There are 3 tab buttons');

        const tabStyles = window.getComputedStyle(tabs[0]);
        // Bold can be "bold" or "700" depending on browser
        const isBold = tabStyles.fontWeight === 'bold' || parseInt(tabStyles.fontWeight) >= 700;
        assert(tabStyles.fontSize === '14px', `Tab 1 font size is ${tabStyles.fontSize} (Expected: 14px to match Stats)`);
        assert(isBold, `Tab 1 font weight is ${tabStyles.fontWeight} (Expected: Bold/700)`);
    }

    // 2. Verify Add User Button Styles
    const addBtn = document.querySelector('.user-manage-add-btn');
    assert(addBtn, 'Add User button (.user-manage-add-btn) exists');
    if (addBtn) {
        const styles = window.getComputedStyle(addBtn);
        const isBold = styles.fontWeight === 'bold' || parseInt(styles.fontWeight) >= 700;
        assert(styles.fontSize === '14px', `User Button font size is ${styles.fontSize} (Expected: 14px to match Stats)`);
        assert(isBold, `User Button font weight is ${styles.fontWeight} (Expected: Bold/700)`);
    }

    // 3. Verify Course Type Add Button Styles
    const addTypeBtn = document.getElementById('addScheduleTypeBtn');
    if (addTypeBtn) { // Might not be visible if not on that page, but if DOM exists
        const styles = window.getComputedStyle(addTypeBtn);
        const isBold = styles.fontWeight === 'bold' || parseInt(styles.fontWeight) >= 700;
        assert(styles.fontSize === '14px', `Type Button font size is ${styles.fontSize} (Expected: 14px to match Stats)`);
        assert(isBold, `Type Button font weight is ${styles.fontWeight} (Expected: Bold/700)`);
    } else {
        console.warn('⚠️ Course Type Button not found (check visibility)');
    }

    // 4. Verify Table Styles inheritance
    const table = document.getElementById('usersTable');
    assert(table, 'Users table (#usersTable) exists');
    if (table) {
        const th = table.querySelector('thead th');
        if (th) {
            const thStyles = window.getComputedStyle(th);
            assert(thStyles.fontSize === '18px', `Header font size is ${thStyles.fontSize} (Expected: 18px)`);
            assert(thStyles.height === '76px', `Header height is ${thStyles.height} (Expected: 76px)`);
        }
    }

    // 4. Verify User Role Mapping (Data Fields)
    // Check if USER_FIELDS are defined correctly (mock check based on implementation knowledge)
    // We can check if calling renderUsersTableHeader works without error
    try {
        if (window.UserManager && window.UserManager.renderUsersTableHeader) {
            window.UserManager.renderUsersTableHeader('admin');
            const adminHeaders = document.querySelectorAll('#usersTable thead th');
            assert(adminHeaders.length > 0, 'Admin headers rendered successfully');

            window.UserManager.renderUsersTableHeader('teacher');
            const teacherHeaders = document.querySelectorAll('#usersTable thead th');
            assert(teacherHeaders.length > 0, 'Teacher headers rendered successfully');

            // Restore admin
            window.UserManager.renderUsersTableHeader('admin');
        } else {
            console.warn('⚠️ UserManager not accessible directly for testing methods');
        }
    } catch (e) {
        assert(false, `Error testing header rendering: ${e.message}`);
    }

    console.log(`\nTest Summary: ${passed} Passed, ${failed} Failed`);
    console.groupEnd();
}

// Expose to window for manual run
window.runUserManagementTests = runUserManagementTests;
console.log('User Management tests loaded. Run runUserManagementTests() to verify.');
