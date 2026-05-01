import '@servicenow/sdk/global'

declare global {
    namespace Now {
        namespace Internal {
            interface Keys extends KeysRegistry {
                explicit: {
                    bom_json: {
                        table: 'sys_module'
                        id: '02203634e35c4625b176402d6eed2d7a'
                    }
                    br0: {
                        table: 'sys_script'
                        id: '6d92daa1de8b4be89a860560b8d1901f'
                    }
                    cs0: {
                        table: 'sys_script_client'
                        id: 'fee4cf4532c94789af078a00ceabf031'
                    }
                    package_json: {
                        table: 'sys_module'
                        id: 'd1cd885971b247078f6c60790e9309e7'
                    }
                    src_server_script_js: {
                        table: 'sys_module'
                        id: '8d6bcaf55a5445ec85b8c0e97b0e74f4'
                    }
                }
            }
        }
    }
}
