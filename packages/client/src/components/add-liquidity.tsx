import { useState, useEffect, useMemo, useContext } from 'react';
import {
    Row,
    Col,
    Card,
    DropdownButton,
    Dropdown,
    Form,
    FormControl,
    InputGroup,
    Modal,
} from 'react-bootstrap';

import { ethers } from 'ethers';
import BigNumber from 'bignumber.js';
import { PendingTxContext, PendingTx } from 'app';
import {compactHash} from 'util/formats';
import mixpanel from 'util/mixpanel';
import erc20Abi from 'constants/abis/erc20.json';
import exchangeAddAbi from 'constants/abis/volumefi_add_liquidity_uniswap.json';

const EXCHANGE_ADD_ABI_ADDRESS = '0xFd8A61F94604aeD5977B31930b48f1a94ff3a195';

import {
    EthGasPrices,
    LPPositionData,
    IUniswapPair,
} from '@sommelier/shared-types';
import {
    Wallet,
    WalletBalances,
    ManageLiquidityActionState,
} from 'types/states';

import { calculatePoolEntryData } from 'util/uniswap-pricing';

import { resolveLogo } from 'components/token-with-logo';
import { AddLiquidityActionButton } from 'components/liquidity-action-button';
import classNames from 'classnames';
import { toastWarn } from 'util/toasters';

function AddLiquidity({
    wallet,
    provider,
    pairData,
    positionData,
    gasPrices,
    balances,
    onDone,
    onClose,
}: {
    wallet: Wallet;
    provider: ethers.providers.Web3Provider | null;
    pairData: IUniswapPair | null;
    positionData: LPPositionData<string> | null;
    gasPrices: EthGasPrices | null;
    balances: WalletBalances;
    onDone: (hash?: string) => void;
    onClose: () => void;
}): JSX.Element | null {
    const [entryToken, setEntryToken] = useState<string>('ETH');
    const [entryAmount, setEntryAmount] = useState<string>('');
    const [slippageTolerance, setSlippageTolerance] = useState<number>(3.0);
    const [currentGasPrice, setCurrentGasPrice] = useState<number | undefined>(
        gasPrices?.standard
    );
    const [approvalState, setApprovalState] = useState<'needed' | 'done'>(
        'needed'
    );
    const [txSubmitted, setTxSubmitted] = useState(false);
    const maxBalance = balances[entryToken]?.balance;
    const maxBalanceStr = ethers.utils.formatUnits(
        maxBalance || 0,
        parseInt(balances[entryToken]?.decimals || '0', 10)
    );
    const { setPendingTx } = useContext(PendingTxContext);

    const resetForm = () => {
        setEntryToken('ETH');
        setEntryAmount('0');
        setSlippageTolerance(3.0);
    };

    const {
        expectedLpTokens,
        expectedPoolToken0,
        expectedPoolToken1,
        expectedPriceImpact,
    } = calculatePoolEntryData(pairData, entryToken, entryAmount);

    useEffect(() => {
        // No need to check allowances for ETH
        if (entryToken === 'ETH' || !entryAmount) return;

        const allowance = balances[entryToken]?.allowance;

        if (!allowance) return;

        const entryAmtNum = new BigNumber(entryAmount);
        const allowanceStr = ethers.utils.formatUnits(
            allowance || 0,
            parseInt(balances[entryToken]?.decimals || '0', 10)
        );
        const allowanceNum = new BigNumber(allowanceStr);
        // If allowance is less than entry amount, make it needed
        if (entryAmtNum.gt(allowanceNum)) {
            setApprovalState('needed');
        } else {
            // else make it done
            setApprovalState('done');
        }
    }, [entryAmount, entryToken, balances]);

    useEffect(() => {
        setEntryAmount('');
    }, [entryToken]);

    const doApprove = async () => {
        if (!pairData || !provider) return;

        if (!currentGasPrice) {
            throw new Error('Gas price not selected.');
        }

        // Create signer
        const signer = provider.getSigner();
        // Create read-write contract instance

        let sellToken = entryToken;
        const symbol0 = pairData.token0.symbol;
        const symbol1 = pairData.token1.symbol;

        if (entryToken === symbol0 && symbol0 !== 'WETH') {
            sellToken = pairData.token0.id;
        } else if (entryToken === symbol1 && symbol1 !== 'WETH') {
            sellToken = pairData.token1.id;
        } else if (entryToken === 'WETH') {
            // We have ETH
            sellToken = '0xC02aaA39b223FE8D0A0e5C4F27eAD9083C756Cc2';
        } else {
            throw new Error(`Could not sell from this token: ${sellToken}`);
        }

        const sellTokenContract = new ethers.Contract(
            sellToken,
            erc20Abi,
            signer
        );

        const decimals = parseInt(balances[entryToken]?.decimals || '0', 10);
        if (decimals === 0) {
            throw new Error(
                `Do not have decimal units for ${decimals} - unsafe, cannot proceed`
            );
        }

        const baseAmount = ethers.utils
            .parseUnits(
                new BigNumber(entryAmount).times(100).toString(),
                decimals
            )
            .toString();
        const baseGasPrice = ethers.utils
            .parseUnits(currentGasPrice.toString(), 9)
            .toString();

        // Call the contract and sign
        let gasEstimate: ethers.BigNumber;

        try {
            gasEstimate = await sellTokenContract.estimateGas.approve(
                EXCHANGE_ADD_ABI_ADDRESS,
                baseAmount,
                { gasPrice: baseGasPrice }
            );

            // Add a 30% buffer over the ethers.js gas estimate. We don't want transactions to fail
            gasEstimate = gasEstimate.add(gasEstimate.div(3));
        } catch (err) {
            // We could not estimate gas, for whaever reason, so we will use a high default to be safe.
            console.error(`Could not estimate gas: ${err.message as string}`);

            gasEstimate = ethers.BigNumber.from('1000000');
        }

        // Approve the add liquidity contract to spend entry tokens
        const { hash } = await sellTokenContract.approve(
            EXCHANGE_ADD_ABI_ADDRESS,
            baseAmount,
            {
                gasPrice: baseGasPrice,
                gasLimit: gasEstimate, // setting a high gas limit because it is hard to predict gas we will use
            }
        );

        // setApprovalState('pending');
        toastWarn(`Approving tx ${compactHash(hash)}`);
        setPendingTx &&
            setPendingTx(
                (state: PendingTx): PendingTx =>
                    ({
                        approval: [...state.approval, hash],
                        confirm: [...state.confirm],
                    } as PendingTx)
            );
        await provider.waitForTransaction(hash);
        onClose();
        // setApprovalState('done');
        await doAddLiquidity();
    };

    const doAddLiquidity = async () => {
        if (!pairData || !provider) return;

        if (!currentGasPrice) {
            throw new Error('Gas price not selected.');
        }

        const expectedLpTokensNum = new BigNumber(expectedLpTokens);
        const slippageRatio = new BigNumber(slippageTolerance).div(100);
        const minPoolTokens = expectedLpTokensNum.times(
            new BigNumber(1).minus(slippageRatio)
        );

        let sellToken = entryToken;
        const symbol0 = pairData.token0.symbol;
        const symbol1 = pairData.token1.symbol;
        const pairAddress = pairData.id;

        if (entryToken === symbol0 && symbol0 !== 'WETH') {
            sellToken = pairData.token0.id;
        } else if (entryToken === symbol1 && symbol1 !== 'WETH') {
            sellToken = pairData.token1.id;
        } else if (entryToken === 'WETH') {
            // We have WETH
            sellToken = '0xC02aaA39b223FE8D0A0e5C4F27eAD9083C756Cc2';
        } else if (entryToken === 'ETH') {
            sellToken = '0xEeeeeEeeeEeEeeEeEeEeeEEEeeeeEeeeeeeeEEeE';
        } else {
            throw new Error(`Could not sell from this token: ${sellToken}`);
        }

        // Create signer
        const signer = provider.getSigner();
        // Create read-write contract instance
        const addLiquidityContract = new ethers.Contract(
            EXCHANGE_ADD_ABI_ADDRESS,
            exchangeAddAbi,
            signer
        );

        const decimals = parseInt(balances[entryToken]?.decimals || '0', 10);
        if (decimals === 0) {
            throw new Error(
                `Do not have decimal units for ${decimals} - unsafe, cannot proceed`
            );
        }

        const baseAmount = ethers.utils
            .parseUnits(entryAmount.toString(), decimals)
            .toString();
        const baseMinPoolTokens = ethers.utils
            .parseUnits(minPoolTokens.toString(), 18)
            .toString();
        let baseMsgValue = ethers.utils.parseUnits('0.005', 18);
        if (entryToken === 'ETH') {
            baseMsgValue = baseMsgValue.add(
                ethers.utils.parseUnits(entryAmount.toString(), decimals)
            );
        }
        const value = baseMsgValue.toString();
        const baseGasPrice = ethers.utils
            .parseUnits(currentGasPrice.toString(), 9)
            .toString();

        try {
            mixpanel.track('transaction:addLiquidity', {
                distinct_id: pairAddress,
                amount: entryAmount.toString(),
                entryToken,
                pair: pairAddress,
                slippageTolerance,
                wallet: wallet.account,
            });
        } catch (e) {
            console.error(`Metrics error on add liquidity.`);
        }

        // Call the contract and sign
        let gasEstimate: ethers.BigNumber;

        try {
            gasEstimate = await addLiquidityContract.estimateGas[
                'investTokenForEthPair(address,address,uint256,uint256)'
            ](sellToken, pairAddress, baseAmount, baseMinPoolTokens, {
                gasPrice: baseGasPrice,
                value, // flat fee sent to contract - 0.0005 ETH - with ETH added if used as entry
            });

            // Add a 30% buffer over the ethers.js gas estimate. We don't want transactions to fail
            gasEstimate = gasEstimate.add(gasEstimate.div(3));
        } catch (err) {
            // We could not estimate gas, for whaever reason, so we will use a high default to be safe.
            console.error(`Could not estimate gas: ${err.message as string}`);

            gasEstimate = ethers.BigNumber.from('1000000');
        }

        const { hash } = await addLiquidityContract[
            'investTokenForEthPair(address,address,uint256,uint256)'
        ](sellToken, pairAddress, baseAmount, baseMinPoolTokens, {
            gasPrice: baseGasPrice,
            gasLimit: gasEstimate,
            value, // flat fee sent to contract - 0.0005 ETH - with ETH added if used as entry
        });

        setTxSubmitted(true);

        // Close the modal after one second
        setTimeout(() => {
            setTxSubmitted(false);
            resetForm();
            onClose();
            onDone?.(hash);
        }, 500);
    };

    const addLiquidityActionState: ManageLiquidityActionState = useMemo(() => {
        if (gasPrices == null) {
            return 'awaitingGasPrices';
        } else if (txSubmitted) {
            return 'submitted';
        } else if (!entryAmount || new BigNumber(entryAmount).lte(0)) {
            return 'amountNotEntered';
        } else if (new BigNumber(entryAmount).gt(maxBalanceStr)) {
            return 'insufficientFunds';
        } else if (new BigNumber(expectedPriceImpact).gt(slippageTolerance)) {
            return 'slippageTooHigh';
        } else if (currentGasPrice == null) {
            return 'gasPriceNotSelected';
        } else if (approvalState === 'needed' && entryToken !== 'ETH') {
            return 'needsApproval';
            // } else if (approvalState === 'pending') {
            //     return 'waitingApproval';
        } else if (
            new BigNumber(entryAmount).lte(maxBalanceStr) &&
            new BigNumber(entryAmount).gt(0)
        ) {
            return 'needsSubmit';
        } else {
            return 'unknown';
        }
    }, [
        gasPrices,
        currentGasPrice,
        entryAmount,
        entryToken,
        maxBalanceStr,
        expectedPriceImpact,
        slippageTolerance,
        txSubmitted,
        approvalState,
    ]);

    if (!wallet || !provider || !pairData) {
        return <p className='centered'>Connect your wallet to continue.</p>;
    }

    let currentLpTokens: string | null = null;

    if (!maxBalance || !pairData) {
        return null;
    }

    if (positionData) {
        const pairPosition = positionData.positions[pairData.id];

        if (!pairPosition) {
            currentLpTokens = new BigNumber(0).toFixed(4);
        } else {
            const lastPosition = pairPosition[pairPosition.length - 1];
            currentLpTokens = new BigNumber(
                lastPosition.liquidityTokenBalance
            ).toFixed(4);
        }
    }

    const dropdownOptions = Object.values(balances).filter(
        (balance) => balance.id !== pairData.id
    );

    return (
        <>
            <Modal.Body className='connect-wallet-modal'>
                <Form.Group>
                    <Form.Label>
                        <h5>
                            Available <strong>{entryToken}</strong>{' '}
                            {maxBalanceStr}
                        </h5>
                    </Form.Label>
                    &nbsp;&nbsp;
                    <button
                        className='btn-neutral'
                        onClick={() => setEntryAmount(maxBalanceStr)}
                    >
                        Max
                    </button>
                    <InputGroup>
                        <FormControl
                            min='0'
                            placeholder='Amount'
                            value={entryAmount}
                            onChange={(e) => {
                                const val = e.target.value;

                                if (!val || !new BigNumber(val).isNaN()) {
                                    setEntryAmount(val);
                                }
                            }}
                        />
                        <DropdownButton
                            as={InputGroup.Append}
                            title={entryToken}
                        >
                            {dropdownOptions.map((token) => (
                                <Dropdown.Item
                                    key={token.symbol}
                                    active={token.symbol === entryToken}
                                    onClick={() =>
                                        setEntryToken(token.symbol as string)
                                    }
                                >
                                    {token.symbol}
                                </Dropdown.Item>
                            ))}
                        </DropdownButton>
                    </InputGroup>
                </Form.Group>
                <h5>Expected Pool Shares</h5>
                <Card body>
                    <div className='modal-pool-shares'>
                        <div>
                            {resolveLogo(pairData.token0.id)}{' '}
                            {pairData.token0.symbol}
                        </div>
                        <div>
                            {expectedPoolToken0 !== 'NaN'
                                ? expectedPoolToken0
                                : 0}{' '}
                        </div>
                        <div>
                            {resolveLogo(pairData.token1.id)}{' '}
                            {pairData.token1.symbol}
                        </div>
                        <div>
                            {expectedPoolToken1 !== 'NaN'
                                ? expectedPoolToken1
                                : 0}{' '}
                        </div>

                        <div>LP Tokens</div>
                        <div>
                            {expectedLpTokens !== 'NaN' ? expectedLpTokens : 0}{' '}
                            {currentLpTokens && (
                                <span className='current-lp-tokens'>
                                    {' '}
                                    ({currentLpTokens} Current)
                                </span>
                            )}
                        </div>
                        <div>Price Impact</div>
                        <div>
                            {expectedPriceImpact !== 'NaN'
                                ? expectedPriceImpact
                                : 0}
                            %
                        </div>
                    </div>
                </Card>
                <br />
                <h5>Transaction Settings</h5>
                <Card body>
                    <Form.Group as={Row}>
                        <Form.Label column sm={6}>
                            Slippage Tolerance
                        </Form.Label>
                        <Col sm={2}></Col>
                        <Col sm={4}>
                            <InputGroup>
                                <FormControl
                                    min='0'
                                    className='slippage-tolerance-input'
                                    value={slippageTolerance}
                                    type='number'
                                    onChange={(e) => {
                                        setSlippageTolerance(
                                            parseFloat(e.target.value)
                                        );
                                    }}
                                />
                                <InputGroup.Append>
                                    <InputGroup.Text>%</InputGroup.Text>
                                </InputGroup.Append>
                            </InputGroup>
                        </Col>
                    </Form.Group>
                    {gasPrices && (
                        <Form.Group className='transaction-speed-input'>
                            <Form.Label>Transaction Speed</Form.Label>
                            <div className='button-group-h'>
                                <button
                                    className={classNames({
                                        active:
                                            currentGasPrice ===
                                            gasPrices.standard,
                                    })}
                                    onClick={() =>
                                        setCurrentGasPrice(gasPrices.standard)
                                    }
                                >
                                    Standard <br />({gasPrices.standard} Gwei)
                                </button>
                                <button
                                    className={classNames({
                                        active:
                                            currentGasPrice === gasPrices.fast,
                                    })}
                                    onClick={() =>
                                        setCurrentGasPrice(gasPrices.fast)
                                    }
                                >
                                    Fast <br />({gasPrices.fast} Gwei)
                                </button>
                                <button
                                    className={classNames({
                                        active:
                                            currentGasPrice ===
                                            gasPrices.fastest,
                                    })}
                                    onClick={() =>
                                        setCurrentGasPrice(gasPrices.fastest)
                                    }
                                >
                                    Fastest <br />({gasPrices.fastest} Gwei)
                                </button>
                            </div>
                        </Form.Group>
                    )}
                </Card>
                {new BigNumber(pairData.reserveUSD).lt(2000000) && (
                    <div className='warn-well'>
                        <p>
                            <strong>Warning: </strong> Low liquidity pairs can
                            experience high slippage at low entry amounts. Be
                            careful when using high slippage tolerance.
                        </p>
                    </div>
                )}
            </Modal.Body>
            <Modal.Footer className='manage-liquidity-modal-footer'>
                <AddLiquidityActionButton
                    state={addLiquidityActionState}
                    onApprove={doApprove}
                    onAddLiquidity={doAddLiquidity}
                />
            </Modal.Footer>
        </>
    );
}

export default AddLiquidity;
