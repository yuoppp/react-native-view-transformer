'use strict';

import React from 'react';
import ReactNative, {
	View,
	Animated,
	Easing,
	NativeModules
} from 'react-native';

import PropTypes from 'prop-types';

import {
	createResponder
} from 'react-native-gesture-responder';
import Scroller from 'react-native-scroller';
import {
	Rect,
	Transform,
	transformedRect,
	availableTranslateSpace,
	fitCenterRect,
	alignedRect,
	getTransform,
	bounceBackRect,
	leavesBoundaries,
	availableFlingSpace
} from './TransformUtils';

export default class ViewTransformer extends React.Component {

	static Rect = Rect;
	static getTransform = getTransform;

	constructor(props) {
		super(props);

		let { translateX, translateY, scale } = this.props.initialTransform;

		this.state = {
			//transform state
			scale: scale,
			translateX: translateX,
			translateY: translateY,

			//animation state
			animator: new Animated.Value(0),

			//layout
			width: 0,
			height: 0,
			pageX: 0,
			pageY: 0,
		};
		this._viewPortRect = new Rect(); //A holder to avoid new too much

		this.cancelAnimation = this.cancelAnimation.bind(this);
		this.contentRect = this.contentRect.bind(this);
		this.transformedContentRect = this.transformedContentRect.bind(this);
		this.animate = this.animate.bind(this);

		this.scroller = new Scroller(false, (dx, dy, scroller) => {

			if (dx === 0 && dy === 0 && scroller.isFinished()) {
				this.animateBounce();
				return;
			}

			this.updateTransform({
				translateX: this.state.translateX + dx / this.state.scale,
				translateY: this.state.translateY + dy / this.state.scale
			})
		});
	}

	viewPortRect() {
		this._viewPortRect.set(0, 0, this.state.width, this.state.height);
		return this._viewPortRect;
	}

	contentRect() {
		let rect = this.viewPortRect().copy();
		if (this.props.contentAspectRatio && this.props.contentAspectRatio > 0) {
			rect = fitCenterRect(this.props.contentAspectRatio, rect);
		}
		return rect;
	}

	transformedContentRect() {
		let rect = transformedRect(this.viewPortRect(), this.currentTransform());
		if (this.props.contentAspectRatio && this.props.contentAspectRatio > 0) {
			rect = fitCenterRect(this.props.contentAspectRatio, rect);
		}
		return rect;
	}

	scaledContentRect() {

		let rect = this.viewPortRect();

		let l = rect.left * this.state.scale;
		let r = rect.right * this.state.scale;
		let t = rect.top * this.state.scale;
		let b = rect.bottom * this.state.scale;

		return new Rect(l, t, r, b);
	}

	visibleViewPortRect() {

		let rect = this.transformedContentRect();

		let left = -rect.left;
		let top = -rect.top;
		let right = left + this.props.viewPortWidth;
		let bottom = top + this.props.viewPortHeight;

		return new Rect(left, top, right, bottom);
	}

	currentTransform() {
		return new Transform(this.state.scale, this.state.translateX, this.state.translateY);
	}

	componentWillMount() {
		this.gestureResponder = createResponder({
			onStartShouldSetResponder: (evt, gestureState) => true,
			onMoveShouldSetResponderCapture: (evt, gestureState) => true,
			//onMoveShouldSetResponder: this.handleMove,
			onResponderMove: this.onResponderMove.bind(this),
			onResponderGrant: this.onResponderGrant.bind(this),
			onResponderRelease: this.onResponderRelease.bind(this),
			onResponderTerminate: this.onResponderRelease.bind(this),
			onResponderTerminationRequest: (evt, gestureState) => false, //Do not allow parent view to intercept gesture
			onResponderSingleTapConfirmed: (evt, gestureState) => {
				this.props.onSingleTapConfirmed && this.props.onSingleTapConfirmed();
			}
		});
	}

	componentDidUpdate(prevProps, prevState) {
		this.props.onViewTransformed && this.props.onViewTransformed({
			scale: this.state.scale,
			translateX: this.state.translateX,
			translateY: this.state.translateY
		});
	}

	componentWillUnmount() {
		this.cancelAnimation();
	}

	render() {
		let gestureResponder = this.gestureResponder;
		if (!this.props.enableTransform) {
			gestureResponder = {};
		}

		return (
			<View
				{...this.props}
				{...gestureResponder}
				ref={'innerViewRef'}
				onLayout={this.onLayout.bind(this)}>
				<View
					style={{
						flex: 1,
						transform: [
							{scale: this.state.scale},
							{translateX: this.state.translateX},
							{translateY: this.state.translateY}
						]
					}}>
					{this.props.children}
				</View>
			</View>
		);
	}

	onLayout(e) {
		const {
			width,
			height
		} = e.nativeEvent.layout;
		if (true || width !== this.state.width || height !== this.state.height) {
			this.setState({
				width,
				height,
			});
		}
		this.measureLayout();

		this.props.onLayout && this.props.onLayout(e);
	}

	measureLayout() {
		let handle = ReactNative.findNodeHandle(this.refs['innerViewRef']);
		NativeModules.UIManager.measure(handle, ((x, y, width, height, pageX, pageY) => {
			if (typeof pageX === 'number' && typeof pageY === 'number') { //avoid undefined values on Android devices
				if (this.state.pageX !== pageX || this.state.pageY !== pageY) {
					this.setState({
						pageX: pageX,
						pageY: pageY
					});
				}
			}

		}).bind(this));
	}

	onResponderGrant(evt, gestureState) {
		this.props.onTransformStart && this.props.onTransformStart();
		this.setState({
			responderGranted: true
		});
		this.measureLayout();

		// force fling animation finish
		this.scroller.forceFinished(true);
	}

	onResponderMove(evt, gestureState) {
		this.cancelAnimation();

		let dx = gestureState.moveX - gestureState.previousMoveX;
		let dy = gestureState.moveY - gestureState.previousMoveY;
		if (this.props.enableResistance && leavesBoundaries(this.visibleViewPortRect(), this.scaledContentRect())) {

			let d = this.applyResistance(dx, dy);
			dx = d.dx;
			dy = d.dy;
		}

		if (!this.props.enableTranslate) {
			dx = dy = 0;
		}

		let transform = {};
		if (gestureState.previousPinch && gestureState.pinch && this.props.enableScale) {

			let scaleBy = gestureState.pinch / gestureState.previousPinch;
			let pivotX = gestureState.moveX - this.state.pageX;
			let pivotY = gestureState.moveY - this.state.pageY;

			let newScale = this.state.scale * scaleBy;

			if (!this.props.allowOverscale) {

				if (newScale <= this.props.minScale) {

					scaleBy = this.props.minScale / this.state.scale;
				} else if (newScale >= this.props.maxScale) {

					scaleBy = this.props.maxScale / this.state.scale;
				}
			}

			let rect = transformedRect(transformedRect(this.contentRect(), this.currentTransform()), new Transform(
				scaleBy, dx, dy, {
					x: pivotX,
					y: pivotY
				}
			));

			transform = getTransform(this.contentRect(), rect);

		} else {

			transform.translateX = this.state.translateX + dx / this.state.scale;
			transform.translateY = this.state.translateY + dy / this.state.scale;
		}

		this.updateTransform(transform);

		return true;
	}

	onResponderRelease(evt, gestureState) {

		let handled = this.props.onTransformGestureReleased && this.props.onTransformGestureReleased({
			scale: this.state.scale,
			translateX: this.state.translateX,
			translateY: this.state.translateY
		});

		if (handled) {
			return;
		}

		if (gestureState.doubleTapUp) {

			if (!this.props.enableScale) {

				this.animateBounce();
				return;
			}

			let pivotX = 0,
				pivotY = 0;

			if (gestureState.dx || gestureState.dy) {

				pivotX = gestureState.moveX - this.state.pageX;
				pivotY = gestureState.moveY - this.state.pageY;
			} else {

				pivotX = gestureState.x0 - this.state.pageX;
				pivotY = gestureState.y0 - this.state.pageY;
			}

			this.performDoubleTapUp(pivotX, pivotY);
		} else {

			if (this.props.enableTranslate) {

				this.performFling(gestureState.vx, gestureState.vy);
			} else {

				this.animateBounce();
			}
		}
	}

	performFling(vx, vy) {

		let startX = 0;
		let startY = 0;
		let maxX, minX, maxY, minY;
		let availablePanDistance = availableFlingSpace(this.visibleViewPortRect(), this.scaledContentRect());

		if (vx > 0) {
			minX = 0;
			if (availablePanDistance.left > 0) {
				maxX = availablePanDistance.left + this.props.maxOverScrollDistance;
			} else {
				maxX = 0;
			}
		} else {
			maxX = 0;
			if (availablePanDistance.right < 0) {
				minX = availablePanDistance.right - this.props.maxOverScrollDistance;
			} else {
				minX = 0;
			}
		}
		if (vy > 0) {
			minY = 0;
			if (availablePanDistance.top > 0) {
				maxY = availablePanDistance.top + this.props.maxOverScrollDistance;
			} else {
				maxY = 0;
			}
		} else {
			maxY = 0;
			if (availablePanDistance.bottom < 0) {
				minY = availablePanDistance.bottom - this.props.maxOverScrollDistance;
			} else {
				minY = 0;
			}
		}

		vx *= 1000; //per second
		vy *= 1000;

		this.scroller.fling(startX, startY, vx, vy, minX, maxX, minY, maxY);
	}

	performDoubleTapUp(pivotX, pivotY) {

		// console.log('performDoubleTapUp...pivot=' + pivotX + ', ' + pivotY);

		let curScale = this.state.scale;
		let scaleBy;
		if (curScale > (1 + this.props.maxScale) / 2) {

			scaleBy = 1 / curScale;
		} else {

			scaleBy = this.props.maxScale / curScale;
		}

		let rect = transformedRect(this.transformedContentRect(), new Transform(
			scaleBy, 0, 0, {
				x: pivotX,
				y: pivotY
			}
		));

		let viewPort = this.scaledContentRect();
		let visibleViewPortRect = this.visibleViewPortRect();

		rect = bounceBackRect(rect, viewPort, visibleViewPortRect);

		this.animate(rect);
	}

	applyResistance(dx, dy) {

		let availablePanDistance = availableTranslateSpace(this.visibleViewPortRect(), this.scaledContentRect());

		if ((dx > 0 && availablePanDistance.left < 0) ||
			(dx < 0 && availablePanDistance.right < 0)) {
			dx /= 3;
		}
		if ((dy > 0 && availablePanDistance.top < 0) ||
			(dy < 0 && availablePanDistance.bottom < 0)) {
			dy /= 3;
		}
		return {
			dx,
			dy
		}
	}

	cancelAnimation() {

		this.state.animator.stopAnimation();
	}

	animate(targetRect, durationInMillis) {
		let duration = 200;
		if (durationInMillis) {
			duration = durationInMillis;
		}

		let fromRect = this.transformedContentRect();
		if (fromRect.equals(targetRect)) {
			// console.log('animate...equal rect, skip animation');
			return;
		}

		this.state.animator.removeAllListeners();
		this.state.animator.setValue(0);
		this.state.animator.addListener((state) => {
			let progress = state.value;

			let left = fromRect.left + (targetRect.left - fromRect.left) * progress;
			let right = fromRect.right + (targetRect.right - fromRect.right) * progress;
			let top = fromRect.top + (targetRect.top - fromRect.top) * progress;
			let bottom = fromRect.bottom + (targetRect.bottom - fromRect.bottom) * progress;

			let transform = getTransform(this.contentRect(), new Rect(left, top, right, bottom));
			this.updateTransform(transform);
		});

		Animated.timing(this.state.animator, {
			toValue: 1,
			duration: duration,
			easing: Easing.inOut(Easing.ease)
		}).start();
	}

	animateBounce() {
		let curScale = this.state.scale,
			minScale = this.props.minScale,
			maxScale = this.props.maxScale,
			scaleBy = 1,
			translateX = 0,
			translateY = 0;

		if (curScale > maxScale) {
			scaleBy = maxScale / curScale;
		} else if (curScale < minScale) {
			scaleBy = minScale / curScale;
		}

		let rect = transformedRect(this.transformedContentRect(), new Transform(
			scaleBy,
			0,
			0, {
				x: this.viewPortRect().centerX(),
				y: this.viewPortRect().centerY()
			}
		));

		let viewPort = this.scaledContentRect();

		let visibleViewPortRect = this.visibleViewPortRect();

		rect = transformedRect(rect, new Transform(1, translateX, translateY));
		rect = bounceBackRect(rect, viewPort, visibleViewPortRect);

		// rect = alignedRect(rect, this.viewPortRect());
		this.animate(rect);
	}

	// Above are private functions. Do not use them if you don't known what you are doing.
	// ***********************************************************************************
	// Below are public functions. Feel free to use them.


	updateTransform(transform) {
		this.setState(transform);
	}

	forceUpdateTransform(transform) {
		this.setState(transform);
	}

	getAvailableTranslateSpace() {
		return availableTranslateSpace(this.transformedContentRect(), this.viewPortRect());
	}
}

ViewTransformer.propTypes = {
	/**
	 * Use false to disable transform. Default is true.
	 */
	enableTransform: PropTypes.bool,

	/**
	 * Use false to disable scaling. Default is true.
	 */
	enableScale: PropTypes.bool,

	/**
	 * Use false to disable translateX/translateY. Default is true.
	 */
	enableTranslate: PropTypes.bool,

	/**
	 * Default is 20
	 */
	maxOverScrollDistance: PropTypes.number,

	viewPortWidth: PropTypes.number,
	viewPortHeight: PropTypes.number,

	maxScale: PropTypes.number,
	minScale: PropTypes.number,
	allowOverscale: PropTypes.bool,

	initialTransform: PropTypes.object,

	contentAspectRatio: PropTypes.number,

	/**
	 * Use true to enable resistance effect on over pulling. Default is false.
	 */
	enableResistance: PropTypes.bool,

	onViewTransformed: PropTypes.func,

	onTransformGestureReleased: PropTypes.func,

	onSingleTapConfirmed: PropTypes.func
};

ViewTransformer.defaultProps = {
	maxOverScrollDistance: 20,
	enableScale: true,
	enableTranslate: true,
	enableTransform: true,
	maxScale: 1.2,
	minScale: 0.8,
	allowOverscale: true,
	enableResistance: false,
	initialTransform: {
		translateX: 0,
		translateY: 0,
		scale: 1
	}
};
